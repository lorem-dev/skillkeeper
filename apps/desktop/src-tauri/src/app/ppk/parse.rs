//! Reading the PPK container: header fields, base64 bodies, and the MAC.
//!
//! Structure only -- nothing here decrypts or verifies anything, so it stays
//! readable and every failure mode is a plain parse error. The private blob
//! comes back exactly as stored: ciphertext for an encrypted key, plaintext for
//! an unencrypted one.

/// Everything a `.ppk` file carries, with the bodies decoded from base64.
#[derive(Debug, Clone)]
pub struct PpkFile {
    /// 2 or 3.
    pub version: u8,
    /// SSH algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// `none` or `aes256-cbc`.
    pub encryption: String,
    /// Free-text comment; part of the MAC input, so it must survive verbatim.
    pub comment: String,
    /// SSH-wire public key blob.
    pub public_blob: Vec<u8>,
    /// The private blob as stored: ciphertext when encrypted.
    pub private_blob: Vec<u8>,
    /// `Private-MAC`, hex-decoded: 32 bytes for v3, 20 for v2.
    pub mac: Vec<u8>,
    /// v3 encrypted keys only.
    pub kdf: Option<Argon2Params>,
}

/// The Argon2 parameters a v3 encrypted key stores alongside its ciphertext.
#[derive(Debug, Clone)]
pub struct Argon2Params {
    /// `Argon2id`, `Argon2i`, or `Argon2d`.
    pub flavour: String,
    pub memory_kib: u32,
    pub passes: u32,
    pub parallelism: u32,
    pub salt: Vec<u8>,
}

/// Why a `.ppk` could not be turned into a usable key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PpkError {
    /// Not a PuTTY key file at all.
    NotPpk,
    /// A PuTTY key file of a version this build does not read.
    UnsupportedVersion,
    /// Structurally broken: a missing field, a bad length, bad base64.
    Malformed,
    /// A cipher other than `aes256-cbc`.
    UnsupportedEncryption,
    /// A key algorithm this build cannot convert (notably `ssh-dss`).
    UnsupportedAlgorithm,
    /// The MAC did not match on an encrypted key: the passphrase is wrong.
    WrongPassphrase,
    /// The MAC did not match on an unencrypted key: the file is corrupt.
    Damaged,
}

impl PpkFile {
    /// Whether the private blob is ciphertext.
    pub fn is_encrypted(&self) -> bool {
        self.encryption != "none"
    }
}

/// Parse `text` into its fields, decoding the base64 bodies and the hex MAC.
pub fn parse(text: &str) -> Result<PpkFile, PpkError> {
    // Strip only a trailing carriage return (a CRLF file), not all trailing
    // whitespace: `Comment` is MACed byte-for-byte as PuTTY wrote it, and
    // puttygen accepts a comment with trailing whitespace.
    let mut lines = text.lines().map(|line| line.trim_end_matches('\r'));

    let header = lines.next().ok_or(PpkError::NotPpk)?.trim();
    let rest = header
        .strip_prefix("PuTTY-User-Key-File-")
        .ok_or(PpkError::NotPpk)?;
    let (version, algorithm) = rest.split_once(':').ok_or(PpkError::Malformed)?;
    let version: u8 = version
        .trim()
        .parse()
        .map_err(|_| PpkError::UnsupportedVersion)?;
    if version != 2 && version != 3 {
        return Err(PpkError::UnsupportedVersion);
    }
    let algorithm = algorithm.trim().to_string();

    let mut encryption = None;
    let mut comment = String::new();
    let mut public_blob = None;
    let mut private_blob = None;
    let mut mac = None;
    let mut flavour = None;
    let mut memory_kib = None;
    let mut passes = None;
    let mut parallelism = None;
    let mut salt = None;

    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let (key, raw_value) = line.split_once(':').ok_or(PpkError::Malformed)?;
        let value = raw_value.trim();
        match key {
            "Encryption" => encryption = Some(value.to_string()),
            // Every other field is numeric or a single token, where `.trim()`
            // is correct and harmless; `Comment` is free text that PuTTY MACs
            // byte-for-byte, so only the one mandatory space after the colon
            // is stripped, not any whitespace the user's comment itself has.
            "Comment" => comment = raw_value.strip_prefix(' ').unwrap_or(raw_value).to_string(),
            "Key-Derivation" => flavour = Some(value.to_string()),
            "Argon2-Memory" => memory_kib = Some(value.parse().map_err(|_| PpkError::Malformed)?),
            "Argon2-Passes" => passes = Some(value.parse().map_err(|_| PpkError::Malformed)?),
            "Argon2-Parallelism" => {
                parallelism = Some(value.parse().map_err(|_| PpkError::Malformed)?)
            }
            "Argon2-Salt" => salt = Some(hex_decode(value).ok_or(PpkError::Malformed)?),
            "Private-MAC" => mac = Some(hex_decode(value).ok_or(PpkError::Malformed)?),
            "Public-Lines" => public_blob = Some(read_body(&mut lines, value)?),
            "Private-Lines" => private_blob = Some(read_body(&mut lines, value)?),
            // Unknown fields are skipped rather than rejected: PuTTY has added
            // header lines before and may again, and none of them change how
            // the fields we do read are interpreted.
            _ => {}
        }
    }

    let encryption = encryption.ok_or(PpkError::Malformed)?;
    if encryption != "none" && encryption != "aes256-cbc" {
        return Err(PpkError::UnsupportedEncryption);
    }
    let kdf = if version == 3 && encryption != "none" {
        Some(Argon2Params {
            flavour: flavour.ok_or(PpkError::Malformed)?,
            memory_kib: memory_kib.ok_or(PpkError::Malformed)?,
            passes: passes.ok_or(PpkError::Malformed)?,
            parallelism: parallelism.ok_or(PpkError::Malformed)?,
            salt: salt.ok_or(PpkError::Malformed)?,
        })
    } else {
        None
    };

    // A MAC of the wrong length is a broken file, and it has to be caught
    // here. `verify_slice` simply answers `Err` for a slice that is not its
    // digest's size, which the callers read as "the MAC did not match" and so
    // as a wrong passphrase -- leaving the user retyping a correct passphrase
    // forever, with no way to learn the file is damaged.
    let mac = mac.ok_or(PpkError::Malformed)?;
    if mac.len() != mac_len(version) {
        return Err(PpkError::Malformed);
    }

    Ok(PpkFile {
        version,
        algorithm,
        encryption,
        comment,
        public_blob: public_blob.ok_or(PpkError::Malformed)?,
        private_blob: private_blob.ok_or(PpkError::Malformed)?,
        mac,
        kdf,
    })
}

/// The `Private-MAC` length a key of `version` must carry: v3 MACs are
/// HMAC-SHA-256, v2 MACs HMAC-SHA-1. Only the two versions [`parse`] accepts
/// ever reach here.
fn mac_len(version: u8) -> usize {
    if version == 3 {
        32
    } else {
        20
    }
}

/// Read `count` base64 lines and decode them as one body.
fn read_body<'a>(
    lines: &mut impl Iterator<Item = &'a str>,
    count: &str,
) -> Result<Vec<u8>, PpkError> {
    let count: usize = count.parse().map_err(|_| PpkError::Malformed)?;
    // A line count is attacker-controlled in the sense that a corrupt file can
    // claim any number; cap it so a bad file cannot make us allocate wildly.
    if count > 4096 {
        return Err(PpkError::Malformed);
    }
    let mut encoded = String::new();
    for _ in 0..count {
        encoded.push_str(lines.next().ok_or(PpkError::Malformed)?.trim());
    }
    b64_decode(&encoded).ok_or(PpkError::Malformed)
}

/// Decode standard base64, ignoring padding and whitespace. `None` on any
/// character outside the alphabet.
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in input.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Decode an even-length hex string. `None` on odd length or a non-hex digit.
fn hex_decode(input: &str) -> Option<Vec<u8>> {
    let input = input.trim();
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(input.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ppk::fixtures;

    #[test]
    fn parses_a_v3_encrypted_ed25519_key() {
        let f = parse(fixtures::ED25519_V3_ENC).expect("parses");
        assert_eq!(f.version, 3);
        assert_eq!(f.algorithm, "ssh-ed25519");
        assert_eq!(f.encryption, "aes256-cbc");
        assert_eq!(f.comment, "skillkeeper-test");
        assert!(f.is_encrypted());
        // Public blob starts with the SSH string "ssh-ed25519".
        assert_eq!(&f.public_blob[..4], &[0, 0, 0, 11]);
        assert_eq!(&f.public_blob[4..15], b"ssh-ed25519");
        // Ciphertext is a whole number of AES blocks.
        assert_eq!(f.private_blob.len() % 16, 0);
        assert_eq!(f.mac.len(), 32);
        let kdf = f.kdf.expect("v3 encrypted keys carry KDF parameters");
        assert_eq!(kdf.flavour, "Argon2id");
        assert!(kdf.memory_kib > 0 && kdf.passes > 0 && kdf.parallelism > 0);
        assert!(!kdf.salt.is_empty());
    }

    #[test]
    fn parses_a_v2_encrypted_key() {
        let f = parse(fixtures::ED25519_V2_ENC).expect("parses");
        assert_eq!(f.version, 2);
        assert!(f.is_encrypted());
        assert!(f.kdf.is_none(), "v2 has no KDF block");
        assert_eq!(f.mac.len(), 20, "v2 MACs are HMAC-SHA-1");
    }

    #[test]
    fn parses_an_unencrypted_key() {
        let f = parse(fixtures::ED25519_V3_PLAIN).expect("parses");
        assert_eq!(f.encryption, "none");
        assert!(!f.is_encrypted());
        assert!(f.kdf.is_none(), "an unencrypted key derives nothing");
    }

    #[test]
    fn a_comment_with_trailing_whitespace_survives_parsing() {
        // The MAC covers the comment byte-for-byte as PuTTY wrote it, and
        // puttygen accepts a comment with trailing whitespace. A parser that
        // trims the line, or trims the header value, would silently change
        // what gets MACed and turn a correct passphrase into a reported
        // "wrong passphrase". Build a variant of the fixture with a trailing
        // space added to the `Comment` line and confirm it survives.
        let modified = fixtures::ED25519_V3_PLAIN.replacen(
            "Comment: skillkeeper-test\n",
            "Comment: skillkeeper-test \n",
            1,
        );
        assert_ne!(
            modified,
            fixtures::ED25519_V3_PLAIN,
            "the fixture's Comment line has an unexpected shape"
        );
        let f = parse(&modified).expect("parses");
        assert_eq!(f.comment, "skillkeeper-test ");
    }

    #[test]
    fn parses_rsa_and_ecdsa_headers() {
        assert_eq!(parse(fixtures::RSA_V3_ENC).unwrap().algorithm, "ssh-rsa");
        assert_eq!(
            parse(fixtures::ECDSA_V3_ENC).unwrap().algorithm,
            "ecdsa-sha2-nistp256"
        );
        assert_eq!(
            parse(fixtures::ECDSA_V3_P384).unwrap().algorithm,
            "ecdsa-sha2-nistp384"
        );
    }

    #[test]
    fn a_non_ppk_file_is_rejected_as_not_ppk() {
        assert!(matches!(
            parse("-----BEGIN OPENSSH PRIVATE KEY-----\n"),
            Err(PpkError::NotPpk)
        ));
    }

    #[test]
    fn an_unknown_version_is_rejected() {
        assert!(matches!(
            parse("PuTTY-User-Key-File-9: ssh-rsa\n"),
            Err(PpkError::UnsupportedVersion)
        ));
    }

    #[test]
    fn a_truncated_body_is_malformed() {
        let truncated: String = fixtures::ED25519_V3_ENC
            .lines()
            .take(4)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches!(parse(&truncated), Err(PpkError::Malformed)));
    }

    #[test]
    fn an_unknown_cipher_is_rejected() {
        let swapped = fixtures::ED25519_V3_ENC.replace("aes256-cbc", "rot13-cbc");
        assert!(matches!(
            parse(&swapped),
            Err(PpkError::UnsupportedEncryption)
        ));
    }

    /// Replace the `Private-MAC` value, keeping every other byte of the file
    /// as it was.
    fn with_mac(text: &str, mac: &str) -> String {
        let mut out = String::new();
        for line in text.lines() {
            if line.starts_with("Private-MAC:") {
                out.push_str(&format!("Private-MAC: {mac}"));
            } else {
                out.push_str(line);
            }
            out.push('\n');
        }
        out
    }

    /// A short MAC is a broken file, not a wrong passphrase. Without the
    /// length check the digest comparison just answers "no match", which every
    /// caller reads as a bad passphrase -- so the user retypes a correct one
    /// forever and never learns the file is damaged.
    /// A v3 MAC is 32 bytes. 16 is a truncated file and 20 is a v2-length one;
    /// both are structurally broken and must say so.
    #[test]
    fn a_v3_mac_of_the_wrong_length_is_malformed() {
        let short = with_mac(fixtures::ED25519_V3_ENC, "7f85ae68ca4e5f096f214d088ec3320b");
        assert!(matches!(parse(&short), Err(PpkError::Malformed)));
        let v2_length = with_mac(
            fixtures::ED25519_V3_ENC,
            "bf199050c139436703106665b7476dcbb8556e2e",
        );
        assert!(matches!(parse(&v2_length), Err(PpkError::Malformed)));
        // Rewriting the line is not itself what makes those fail: the real MAC
        // put back through the same helper still parses.
        let rewritten = with_mac(
            fixtures::ED25519_V3_ENC,
            "7f85ae68ca4e5f096f214d088ec3320b3be6574843b0356edca70e0287c88853",
        );
        assert!(parse(&rewritten).is_ok());
    }

    /// The same for v2, whose MAC is 20 bytes.
    #[test]
    fn a_v2_mac_of_the_wrong_length_is_malformed() {
        let short = with_mac(fixtures::ED25519_V2_ENC, "bf199050c139436703106665");
        assert!(matches!(parse(&short), Err(PpkError::Malformed)));
        let v3_length = with_mac(
            fixtures::ED25519_V2_ENC,
            "7f85ae68ca4e5f096f214d088ec3320b3be6574843b0356edca70e0287c88853",
        );
        assert!(matches!(parse(&v3_length), Err(PpkError::Malformed)));
        let rewritten = with_mac(
            fixtures::ED25519_V2_ENC,
            "bf199050c139436703106665b7476dcbb8556e2e",
        );
        assert!(parse(&rewritten).is_ok());
    }

    #[test]
    fn base64_round_trips_against_the_known_vectors() {
        assert_eq!(b64_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(b64_decode("Zg==").unwrap(), b"f");
        assert_eq!(b64_decode("").unwrap(), b"");
        assert!(b64_decode("!!!!").is_none());
    }

    #[test]
    fn hex_decodes_and_rejects_odd_input() {
        assert_eq!(hex_decode("0a0b").unwrap(), vec![0x0a, 0x0b]);
        assert_eq!(hex_decode("FF").unwrap(), vec![0xff]);
        assert!(hex_decode("abc").is_none());
        assert!(hex_decode("zz").is_none());
    }
}
