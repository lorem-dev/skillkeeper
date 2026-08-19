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

use super::decrypt::{ssh_string, unlock};
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
            // reads) get built by hand, using the same `ssh_string` writer
            // `decrypt::mac_data` uses, and decoded through that.
            let mut wire = Vec::new();
            ssh_string(&mut wire, curve.as_str().as_bytes());
            ssh_string(&mut wire, point);
            ssh_string(&mut wire, &scalar);
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

    /// The next raw big-endian `u32`, unlike `string` not length-prefixed.
    /// Only the test-only OpenSSH-fixture reader below needs this, to skip
    /// past the two `checkint`s.
    #[cfg(test)]
    fn u32(&mut self) -> Result<u32, PpkError> {
        let bytes = self
            .data
            .get(self.offset..self.offset + 4)
            .ok_or(PpkError::Malformed)?;
        let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        self.offset += 4;
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
    /// rather than [`ssh_key::PrivateKey::from_openssh`]: `ssh-encoding`
    /// 0.2.0 hard-codes `PEM_LINE_WIDTH = 70` and uses it for both encoding
    /// and decoding, so `ssh-key`'s own PEM reader only accepts 70-column
    /// bodies -- which is what `to_openssh` (and real OpenSSH) produce, so
    /// there is nothing wrong with `from_openssh` itself. puttygen wraps at
    /// 64 columns, though, so its fixtures are the ones `from_openssh` cannot
    /// read. Decoding the base64 by hand and calling `from_bytes` sidesteps
    /// the PEM layer's column requirement entirely; it is test-only code, so
    /// it does not need to be a general PEM parser.
    fn assert_matches_puttygen(ppk: &str, expected: &str, passphrase: &str) {
        let file = parse(ppk).unwrap();
        let converted = convert(&file, passphrase).expect("converts");
        let body = pem_body_bytes(expected);
        let theirs = ssh_key::PrivateKey::from_bytes(&body).expect("fixture decodes");
        let (their_keypair, comment) = puttygen_keypair_data(&theirs, passphrase);
        let normalized = ssh_key::PrivateKey::new(their_keypair, comment)
            .expect("rebuilds")
            .to_openssh(ssh_key::LineEnding::LF)
            .expect("re-encodes");
        assert_eq!(converted.openssh.as_str(), normalized.as_str());
    }

    /// Get puttygen's own `KeypairData` and comment out of its parsed OpenSSH
    /// fixture.
    ///
    /// OpenSSH only stores the comment inside the (possibly encrypted)
    /// private section, unlike a `.ppk`'s cleartext `Comment:` header, so for
    /// an encrypted key `theirs.comment()` is empty until decryption actually
    /// runs -- it has to come out of the same plaintext the keypair fields
    /// do, which is why this returns both together instead of letting the
    /// caller read `theirs.comment()` independently.
    ///
    /// `ssh-key`'s own `PrivateKey::decrypt` also decodes the private section
    /// too strictly for ECDSA: `EcdsaPrivateKey<SIZE>::decode` only accepts a
    /// scalar of exactly `SIZE` bytes, or `SIZE + 1` bytes with an explicit
    /// leading zero. P-521's order is only just over 2^520, so a uniformly
    /// random private scalar routinely serializes to 65 bytes in mpint form
    /// against `ssh-key`'s fixed 66-byte field -- exactly the width mismatch
    /// `left_pad` exists to fix on the way into `ssh-key`. `decrypt()` has no
    /// equivalent leniency on the way out, so it fails on such a key even
    /// with the correct passphrase (confirmed by hand-deriving the same
    /// key/IV with Python's `bcrypt.kdf` and AES-256-CTR: the plaintext is
    /// well-formed, `ssh-key` just refuses to parse it).
    ///
    /// So `ssh-key`'s own `decrypt()` is always tried first, and the
    /// hand-rolled path below runs only for the fixtures it actually refuses
    /// -- in practice P-521, leaving P-256 and P-384 with a decode that owes
    /// nothing to this file's code. When it does run, this derives the key/IV
    /// with `ssh-key`'s own public `Kdf::derive_key_and_iv` (so the KDF itself
    /// is never reimplemented here), then parses the private section by hand
    /// with the same `Reader`/`left_pad`/`decode_as` path `keypair_data` uses
    /// in production.
    fn puttygen_keypair_data(
        theirs: &ssh_key::PrivateKey,
        passphrase: &str,
    ) -> (KeypairData, String) {
        if !theirs.is_encrypted() {
            return (theirs.key_data().clone(), theirs.comment().to_string());
        }
        match theirs.decrypt(passphrase) {
            Ok(decrypted) => {
                return (
                    decrypted.key_data().clone(),
                    decrypted.comment().to_string(),
                )
            }
            // Only an ECDSA scalar may defeat `ssh-key`'s decoder (see above);
            // any other refusal means the fixture or the passphrase is wrong,
            // and falling back would hide that.
            Err(e) => assert!(
                matches!(theirs.algorithm(), ssh_key::Algorithm::Ecdsa { .. }),
                "only an ECDSA fixture may need the hand-rolled path: {e}"
            ),
        }

        let ciphertext = theirs
            .key_data()
            .encrypted()
            .expect("encrypted key holds ciphertext");
        let (key, iv) = theirs
            .kdf()
            .derive_key_and_iv(theirs.cipher(), passphrase)
            .expect("derives key/iv");
        let plaintext = aes256_ctr(&key, &iv, ciphertext);

        let curve = match theirs.algorithm() {
            ssh_key::Algorithm::Ecdsa { curve } => curve,
            _ => unreachable!("checked above"),
        };
        let width = match curve {
            ssh_key::EcdsaCurve::NistP256 => 32,
            ssh_key::EcdsaCurve::NistP384 => 48,
            ssh_key::EcdsaCurve::NistP521 => 66,
        };

        let mut reader = Reader::new(&plaintext);
        // OpenSSH writes one random value twice at the head of the private
        // section precisely so a reader can tell a good decryption from a bad
        // one. It is the only integrity signal on this hand-rolled path --
        // every other field would decode into *something* -- so a wrong key or
        // IV says so here instead of surfacing as a confusing key mismatch at
        // the end of the test. The values themselves are never printed: they
        // come out of the same plaintext the key does.
        let (check1, check2) = (
            reader.u32().expect("checkint1"),
            reader.u32().expect("checkint2"),
        );
        assert!(
            check1 == check2,
            "the hand-rolled decrypt produced garbage: the two checkints differ"
        );
        reader.string().expect("algorithm name");
        reader.string().expect("curve name");
        let point = reader.string().expect("public point");
        let scalar = reader.string().expect("private scalar");
        let scalar = left_pad(scalar, width).expect("scalar fits the field");
        let comment = reader.string().expect("comment");
        let comment = std::str::from_utf8(comment)
            .expect("comment is utf-8")
            .to_string();

        let mut wire = Vec::new();
        ssh_string(&mut wire, curve.as_str().as_bytes());
        ssh_string(&mut wire, point);
        ssh_string(&mut wire, &scalar);
        let mut wire_reader: &[u8] = &wire;
        let keypair = KeypairData::decode_as(&mut wire_reader, ssh_key::Algorithm::Ecdsa { curve })
            .expect("decodes");
        (keypair, comment)
    }

    /// AES-256 in CTR mode, treating `iv` as the initial 128-bit big-endian
    /// counter and incrementing by one per 16-byte block -- the construction
    /// `aes256-ctr` uses in both the OpenSSH and PuTTY ecosystems. Test-only:
    /// it exists so `puttygen_keypair_data` can get at the plaintext without
    /// going through `ssh-key`'s own decrypt-then-strictly-decode path. Built
    /// from the `aes`/`cipher` crates already in this workspace, not a new
    /// dependency.
    fn aes256_ctr(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
        use aes::Aes256;
        use cipher::{BlockEncrypt, KeyInit};

        let cipher = Aes256::new_from_slice(key).expect("32-byte key");
        let mut counter = u128::from_be_bytes(iv.try_into().expect("16-byte iv"));
        let mut out = Vec::with_capacity(data.len());
        for chunk in data.chunks(16) {
            let mut block = cipher::Block::<Aes256>::clone_from_slice(&counter.to_be_bytes());
            cipher.encrypt_block(&mut block);
            for (byte, pad) in chunk.iter().zip(block.iter()) {
                out.push(byte ^ pad);
            }
            counter = counter.wrapping_add(1);
        }
        out
    }

    /// Strip a `-----BEGIN ... -----`/`-----END ... -----` PEM armor and
    /// base64-decode the body, without going through `ssh-key`'s own PEM
    /// decoder (which requires 70-column bodies, not puttygen's 64). Good
    /// enough for trusted test fixtures only.
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
    fn converts_ecdsa_p256_p384_and_p521() {
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
        // P-521's scalar is the one where the mpint/field-width interaction
        // actually exercises `left_pad`'s zero-extension path: its top byte
        // is 0x00 or 0x01 far more often than not, so PuTTY's mpint encoding
        // of it is routinely 65 bytes against ssh-key's fixed 66-byte field.
        assert_matches_puttygen(
            fixtures::ECDSA_V3_P521,
            fixtures::ECDSA_V3_P521_OPENSSH,
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

    /// A plain DSA key can't tell "refused before decrypting" apart from
    /// "rejected for some other reason": there is nothing to decrypt, so any
    /// ordering of the `is_supported` guard and `unlock` produces the same
    /// observable result. An *encrypted* DSA key can: if the guard ran after
    /// `unlock`, a wrong passphrase would fail the MAC first and this would
    /// see `WrongPassphrase` instead.
    #[test]
    fn dsa_is_refused_before_a_wrong_passphrase_is_even_checked() {
        let file = parse(fixtures::DSA_V2_ENC).unwrap();
        assert!(matches!(
            convert(&file, "definitely-not-the-passphrase"),
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

    #[test]
    fn left_pad_leaves_an_exact_width_input_untouched() {
        let bytes = [1u8, 2, 3, 4];
        assert_eq!(left_pad(&bytes, 4).unwrap(), bytes.to_vec());
    }

    #[test]
    fn left_pad_zero_extends_a_short_input() {
        let bytes = [1u8, 2];
        assert_eq!(left_pad(&bytes, 4).unwrap(), vec![0, 0, 1, 2]);
    }

    #[test]
    fn left_pad_trims_a_sign_zero_prefix_down_to_the_width() {
        // A leading zero byte disambiguating a positive mpint whose next byte
        // has its high bit set; once stripped the rest is exactly `width`.
        let bytes = [0u8, 0x80, 2, 3, 4];
        assert_eq!(left_pad(&bytes, 4).unwrap(), vec![0x80, 2, 3, 4]);
    }

    #[test]
    fn left_pad_rejects_input_wider_than_the_target() {
        let bytes = [1u8, 2, 3, 4, 5];
        assert!(left_pad(&bytes, 4).is_err());
    }
}
