//! Turning a decrypted PuTTY key into OpenSSH text.
//!
//! PuTTY and OpenSSH store the same key material in different envelopes, so
//! this is re-encoding, not re-deriving: the private fields are read out of the
//! decrypted blob in the order PuTTY writes them, handed to `ssh-key`, and
//! written back out as an unencrypted OpenSSH key. That text goes straight to
//! `ssh-add` over a pipe and is zeroized after; it never reaches a file.

use ssh_key::private::KeypairData;
use ssh_key::{LineEnding, PrivateKey};
use zeroize::Zeroizing;

use super::decrypt::unlock;
use super::parse::{PpkError, PpkFile};

/// A PuTTY key re-encoded for OpenSSH.
pub struct ConvertedKey {
    /// The unencrypted private key, ready for `ssh-add -`.
    pub openssh: Zeroizing<String>,
    /// The matching `ssh-... AAAA... comment` line, for `ssh-add -d -`. Public
    /// material only.
    pub public_line: String,
}

/// Decrypt `file` and re-encode it as an OpenSSH private key.
///
/// # Errors
///
/// [`PpkError::UnsupportedAlgorithm`] for a key type OpenSSH has no place for
/// (notably `ssh-dss`, which OpenSSH has removed), plus anything [`unlock`]
/// reports.
pub fn convert(file: &PpkFile, passphrase: &str) -> Result<ConvertedKey, PpkError> {
    // Refused before decrypting: there is nothing to convert to, so making the
    // user wait through an Argon2 derivation first would be pure cost.
    if !is_supported(&file.algorithm) {
        return Err(PpkError::UnsupportedAlgorithm);
    }
    let plain = unlock(file, passphrase)?;
    let keypair = keypair_data(file, &plain)?;
    let key = PrivateKey::new(keypair, file.comment.clone()).map_err(|_| PpkError::Malformed)?;
    let openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| PpkError::Malformed)?;
    let public_line = key
        .public_key()
        .to_openssh()
        .map_err(|_| PpkError::Malformed)?;
    Ok(ConvertedKey {
        openssh,
        public_line,
    })
}

/// Whether this build can re-encode the algorithm at all.
fn is_supported(algorithm: &str) -> bool {
    matches!(
        algorithm,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    )
}

/// Read the private fields out of the decrypted blob, in PuTTY's order, and
/// pair them with the public blob's fields.
fn keypair_data(file: &PpkFile, plain: &[u8]) -> Result<KeypairData, PpkError> {
    let mut private = Reader::new(plain);
    let mut public = Reader::new(&file.public_blob);
    // The public blob repeats the algorithm name; skip it.
    public.string()?;

    match file.algorithm.as_str() {
        "ssh-ed25519" => {
            use ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};

            let _public_bytes = public.string()?;
            let secret = private.string()?;
            let secret: [u8; 32] = secret.try_into().map_err(|_| PpkError::Malformed)?;
            let keypair = Ed25519Keypair::from(Ed25519PrivateKey::from_bytes(&secret));
            Ok(KeypairData::Ed25519(keypair))
        }
        "ssh-rsa" => {
            use ssh_key::private::{RsaKeypair, RsaPrivateKey};
            use ssh_key::public::RsaPublicKey;

            let e = mpint(public.string()?)?;
            let n = mpint(public.string()?)?;
            // PuTTY's order: d, p, q, iqmp.
            let d = mpint(private.string()?)?;
            let p = mpint(private.string()?)?;
            let q = mpint(private.string()?)?;
            let iqmp = mpint(private.string()?)?;
            let keypair = RsaKeypair {
                public: RsaPublicKey { e, n },
                private: RsaPrivateKey { d, iqmp, p, q },
            };
            Ok(KeypairData::Rsa(keypair))
        }
        algorithm => {
            use ssh_key::{Algorithm, EcdsaCurve};

            let curve = match algorithm {
                "ecdsa-sha2-nistp256" => EcdsaCurve::NistP256,
                "ecdsa-sha2-nistp384" => EcdsaCurve::NistP384,
                "ecdsa-sha2-nistp521" => EcdsaCurve::NistP521,
                _ => return Err(PpkError::UnsupportedAlgorithm),
            };
            // Public blob: curve name, then the point.
            public.string()?;
            let point = public.string()?;
            let scalar = private.string()?;
            // PuTTY writes the scalar as an mpint, which may carry a leading
            // zero byte or be shorter than the field; ssh-key wants exactly the
            // field width.
            let width = match curve {
                EcdsaCurve::NistP256 => 32,
                EcdsaCurve::NistP384 => 48,
                EcdsaCurve::NistP521 => 66,
            };
            let scalar = left_pad(scalar, width)?;

            // `ssh-key` has no constructor that takes raw point/scalar bytes:
            // `EcdsaPrivateKey`'s field is private, and the only public
            // constructors go through the `p256`/`p384`/`p521` crates, which
            // this crate does not depend on directly. `KeypairData::decode_as`
            // is public, though, and takes anything implementing `Reader` --
            // which `&[u8]` does, unconditionally, in `ssh-key`'s own
            // dependency. So the wire-format bytes for "curve name, point,
            // scalar" (the same layout `EcdsaKeypair`'s own `Decode` impl
            // reads) get built by hand and decoded through that.
            let mut wire = wire_string(curve.as_str().as_bytes());
            wire.extend(wire_string(point));
            wire.extend(wire_string(&scalar));
            let mut wire_reader: &[u8] = &wire;
            let keypair = KeypairData::decode_as(&mut wire_reader, Algorithm::Ecdsa { curve })
                .map_err(|_| PpkError::Malformed)?;
            Ok(keypair)
        }
    }
}

/// Turn raw mpint bytes into `ssh-key`'s `Mpint`.
fn mpint(bytes: &[u8]) -> Result<ssh_key::Mpint, PpkError> {
    ssh_key::Mpint::from_bytes(bytes).map_err(|_| PpkError::Malformed)
}

/// Left-pad (or trim a single leading zero from) an mpint to a fixed width.
fn left_pad(bytes: &[u8], width: usize) -> Result<Vec<u8>, PpkError> {
    let trimmed = match bytes.split_first() {
        Some((0, rest)) if rest.len() >= width => rest,
        _ => bytes,
    };
    if trimmed.len() > width {
        return Err(PpkError::Malformed);
    }
    let mut out = vec![0u8; width - trimmed.len()];
    out.extend_from_slice(trimmed);
    Ok(out)
}

/// Encode `bytes` as an SSH wire "string": a 4-byte big-endian length prefix
/// followed by the bytes.
fn wire_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

/// A cursor over SSH-wire strings.
struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    /// The next length-prefixed string, or [`PpkError::Malformed`] if the blob
    /// ends early or claims a length it does not have.
    fn string(&mut self) -> Result<&'a [u8], PpkError> {
        let header = self
            .data
            .get(self.offset..self.offset + 4)
            .ok_or(PpkError::Malformed)?;
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let start = self.offset + 4;
        let end = start.checked_add(length).ok_or(PpkError::Malformed)?;
        let value = self.data.get(start..end).ok_or(PpkError::Malformed)?;
        self.offset = end;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ppk::fixtures;
    use crate::app::ppk::parse::parse;

    /// Compare against puttygen's own conversion of the same key, after
    /// normalizing both sides through `ssh-key`'s own encoder.
    ///
    /// Both files carry the same key, but each producer's `checkint` (a value
    /// baked into the encrypted-comment-and-key section on encode, chosen
    /// independently by whoever writes the file) differs between puttygen and
    /// `ssh-key`'s `PrivateKey::new`. Comparing the raw files fails even when
    /// the key material is identical. Re-encoding puttygen's parsed key
    /// through the same `PrivateKey::new` -> `to_openssh` path ours took
    /// removes exactly that difference and nothing else, so byte equality
    /// here means the key material and comment are identical.
    ///
    /// puttygen preserves the source `.ppk`'s encryption when it converts to
    /// OpenSSH, so the fixture (unlike our own output, which is always
    /// unencrypted) needs decrypting with the same passphrase first. It is
    /// parsed via [`ssh_key::PrivateKey::from_bytes`] on the base64 body
    /// rather than [`ssh_key::PrivateKey::from_openssh`]: `ssh-key` 0.6.7's
    /// PEM decoder (`pem-rfc7468` 0.7.0) mis-decodes bodies wrapped at
    /// exactly 64 columns -- the width both puttygen and `ssh-key`'s own
    /// encoder use -- so `from_openssh` cannot read these fixtures at all.
    /// Decoding the base64 by hand and calling `from_bytes` skips that broken
    /// layer; it is test-only code, so it does not need to be a general PEM
    /// parser.
    fn assert_matches_puttygen(ppk: &str, expected: &str, passphrase: &str) {
        let file = parse(ppk).unwrap();
        let converted = convert(&file, passphrase).expect("converts");
        let body = pem_body_bytes(expected);
        let theirs = ssh_key::PrivateKey::from_bytes(&body).expect("fixture decodes");
        let theirs = if theirs.is_encrypted() {
            theirs.decrypt(passphrase).expect("fixture decrypts")
        } else {
            theirs
        };
        let normalized = ssh_key::PrivateKey::new(theirs.key_data().clone(), theirs.comment())
            .expect("rebuilds")
            .to_openssh(ssh_key::LineEnding::LF)
            .expect("re-encodes");
        assert_eq!(converted.openssh.as_str(), normalized.as_str());
    }

    /// Strip a `-----BEGIN ... -----`/`-----END ... -----` PEM armor and
    /// base64-decode the body, without going through `ssh-key`'s own (broken,
    /// for 64-column bodies) PEM decoder. Good enough for trusted test
    /// fixtures only.
    fn pem_body_bytes(pem: &str) -> Vec<u8> {
        let body: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        base64_decode(body.as_bytes())
    }

    /// A minimal standard-alphabet base64 decoder, for test fixtures only.
    fn base64_decode(input: &[u8]) -> Vec<u8> {
        fn value(byte: u8) -> Option<u32> {
            match byte {
                b'A'..=b'Z' => Some(u32::from(byte - b'A')),
                b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
                b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        }

        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0u32;
        for &byte in input {
            if byte == b'=' {
                break;
            }
            let Some(v) = value(byte) else {
                continue;
            };
            buf = (buf << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn converts_ed25519_v3_encrypted() {
        assert_matches_puttygen(
            fixtures::ED25519_V3_ENC,
            fixtures::ED25519_V3_ENC_OPENSSH,
            fixtures::PASSPHRASE,
        );
    }

    #[test]
    fn converts_ed25519_v2_encrypted() {
        assert_matches_puttygen(
            fixtures::ED25519_V2_ENC,
            fixtures::ED25519_V2_ENC_OPENSSH,
            fixtures::PASSPHRASE,
        );
    }

    #[test]
    fn converts_rsa() {
        assert_matches_puttygen(
            fixtures::RSA_V3_ENC,
            fixtures::RSA_V3_ENC_OPENSSH,
            fixtures::PASSPHRASE,
        );
        assert_matches_puttygen(
            fixtures::RSA_V2_ENC,
            fixtures::RSA_V2_ENC_OPENSSH,
            fixtures::PASSPHRASE,
        );
    }

    #[test]
    fn converts_ecdsa_p256_and_p384() {
        assert_matches_puttygen(
            fixtures::ECDSA_V3_ENC,
            fixtures::ECDSA_V3_ENC_OPENSSH,
            fixtures::PASSPHRASE,
        );
        assert_matches_puttygen(
            fixtures::ECDSA_V3_P384,
            fixtures::ECDSA_V3_P384_OPENSSH,
            fixtures::PASSPHRASE,
        );
    }

    #[test]
    fn the_public_line_carries_the_algorithm_and_comment() {
        let file = parse(fixtures::ED25519_V3_PLAIN).unwrap();
        let converted = convert(&file, "").unwrap();
        assert!(converted.public_line.starts_with("ssh-ed25519 AAAA"));
        assert!(converted.public_line.ends_with("skillkeeper-test"));
    }

    #[test]
    fn dsa_is_refused_before_any_crypto_runs() {
        let file = parse(fixtures::DSA_V2_PLAIN).unwrap();
        assert!(matches!(
            convert(&file, ""),
            Err(PpkError::UnsupportedAlgorithm)
        ));
    }

    #[test]
    fn a_wrong_passphrase_propagates_from_unlock() {
        let file = parse(fixtures::ED25519_V3_ENC).unwrap();
        assert!(matches!(
            convert(&file, "not-it"),
            Err(PpkError::WrongPassphrase)
        ));
    }
}
