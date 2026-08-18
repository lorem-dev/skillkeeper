//! Deriving keys from the passphrase, decrypting the private blob, and
//! verifying the MAC.
//!
//! The MAC is the passphrase check: PuTTY derives the MAC key from the
//! passphrase too, so a wrong passphrase produces a mismatch rather than
//! garbage that only fails later. That is why a mismatch means "wrong
//! passphrase" for an encrypted key and "corrupt file" for an unencrypted one.

use aes::Aes256;
use cipher::block_padding::NoPadding;
use cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::parse::{Argon2Params, PpkError, PpkFile};

type Aes256CbcDec = cbc::Decryptor<Aes256>;

/// Upper bound on the Argon2 memory a file may ask for, in KiB (1 GiB). A
/// corrupt or hostile file must not be able to make the app allocate the
/// machine out of memory before any authentication has happened.
const MAX_ARGON2_MEMORY_KIB: u32 = 1024 * 1024;

/// Upper bound on Argon2 passes. Generous next to what puttygen writes, and
/// far below what would let a hostile file burn CPU indefinitely with no
/// cancellation -- the same denial of service the memory cap exists to
/// prevent, on the time axis instead of the space one.
const MAX_ARGON2_PASSES: u32 = 64;

/// Upper bound on Argon2 parallelism. Also keeps `parallelism` well clear of
/// the range where `argon2` 0.5's own validation (`m_cost < p_cost * 8`,
/// checked before its own parallelism ceiling) could overflow the
/// multiplication on a hostile value.
const MAX_ARGON2_PARALLELISM: u32 = 16;

/// Decrypt (if needed) and verify the private blob of `file`.
///
/// Returns the plaintext private blob, which still carries PuTTY's trailing
/// padding for an encrypted key -- the caller reads only the fields its
/// algorithm defines.
///
/// # Errors
///
/// [`PpkError::WrongPassphrase`] when the MAC fails on an encrypted key,
/// [`PpkError::Damaged`] when it fails on an unencrypted one, and
/// [`PpkError::Malformed`] for a structurally impossible file.
pub fn unlock(file: &PpkFile, passphrase: &str) -> Result<Zeroizing<Vec<u8>>, PpkError> {
    let (plain, mac_key) = if file.is_encrypted() {
        let kdf = file.kdf.as_ref();
        match file.version {
            3 => {
                let params = kdf.ok_or(PpkError::Malformed)?;
                let derived = derive_v3(params, passphrase)?;
                let plain = aes_cbc_decrypt(&derived[..32], &derived[32..48], &file.private_blob)?;
                (plain, Zeroizing::new(derived[48..80].to_vec()))
            }
            _ => {
                let cipher_key = derive_v2_cipher_key(passphrase);
                let iv = [0u8; 16];
                let plain = aes_cbc_decrypt(&cipher_key, &iv, &file.private_blob)?;
                (plain, v2_mac_key(passphrase))
            }
        }
    } else {
        let plain = Zeroizing::new(file.private_blob.clone());
        let mac_key = match file.version {
            // An unencrypted v3 key has no KDF output to take a MAC key from,
            // so the MAC is keyed with nothing at all.
            3 => Zeroizing::new(Vec::new()),
            _ => v2_mac_key(""),
        };
        (plain, mac_key)
    };

    let data = mac_data(file, &plain);
    let ok = match file.version {
        3 => verify_sha256(&mac_key, &data, &file.mac),
        _ => verify_sha1(&mac_key, &data, &file.mac),
    };
    if !ok {
        return Err(if file.is_encrypted() {
            PpkError::WrongPassphrase
        } else {
            PpkError::Damaged
        });
    }
    Ok(plain)
}

/// The five SSH strings the MAC is taken over, in PuTTY's order.
///
/// Pre-sized to its exact final length: `private_plain` is the decrypted
/// private key, and a plain `Vec` that reallocates while growing leaves
/// partial copies of it scattered in freed heap that no later `Zeroizing`
/// can reach. The whole buffer is `Zeroizing` for the same reason -- it ends
/// up holding that plaintext too, via the last `ssh_string` call.
fn mac_data(file: &PpkFile, private_plain: &[u8]) -> Zeroizing<Vec<u8>> {
    let capacity = 20
        + file.algorithm.len()
        + file.encryption.len()
        + file.comment.len()
        + file.public_blob.len()
        + private_plain.len();
    let mut data = Zeroizing::new(Vec::with_capacity(capacity));
    ssh_string(&mut data, file.algorithm.as_bytes());
    ssh_string(&mut data, file.encryption.as_bytes());
    ssh_string(&mut data, file.comment.as_bytes());
    ssh_string(&mut data, &file.public_blob);
    ssh_string(&mut data, private_plain);
    data
}

/// Append `data` as an SSH string: a big-endian u32 length, then the bytes.
pub(crate) fn ssh_string(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
}

/// Constant-time HMAC-SHA-256 check (PPK v3).
///
/// Two concrete functions rather than one generic over the digest: the generic
/// form needs bounds from the `digest` crate, which is not a dependency of this
/// crate and is not worth becoming one for four lines.
fn verify_sha256(key: &[u8], data: &[u8], expected: &[u8]) -> bool {
    match <Hmac<Sha256> as Mac>::new_from_slice(key) {
        Ok(mut mac) => {
            mac.update(data);
            mac.verify_slice(expected).is_ok()
        }
        Err(_) => false,
    }
}

/// Constant-time HMAC-SHA-1 check (PPK v2).
fn verify_sha1(key: &[u8], data: &[u8], expected: &[u8]) -> bool {
    match <Hmac<Sha1> as Mac>::new_from_slice(key) {
        Ok(mut mac) => {
            mac.update(data);
            mac.verify_slice(expected).is_ok()
        }
        Err(_) => false,
    }
}

/// Argon2 over the passphrase: 80 bytes = 32 cipher key, 16 IV, 32 MAC key.
fn derive_v3(params: &Argon2Params, passphrase: &str) -> Result<Zeroizing<Vec<u8>>, PpkError> {
    use argon2::{Algorithm, Argon2, Params, Version};

    if params.memory_kib > MAX_ARGON2_MEMORY_KIB
        || params.passes > MAX_ARGON2_PASSES
        || params.parallelism > MAX_ARGON2_PARALLELISM
    {
        return Err(PpkError::Malformed);
    }
    let algorithm = match params.flavour.as_str() {
        "Argon2id" => Algorithm::Argon2id,
        "Argon2i" => Algorithm::Argon2i,
        "Argon2d" => Algorithm::Argon2d,
        _ => return Err(PpkError::Malformed),
    };
    let config = Params::new(
        params.memory_kib,
        params.passes,
        params.parallelism,
        Some(80),
    )
    .map_err(|_| PpkError::Malformed)?;
    let mut out = Zeroizing::new(vec![0u8; 80]);
    Argon2::new(algorithm, Version::V0x13, config)
        .hash_password_into(passphrase.as_bytes(), &params.salt, &mut out)
        .map_err(|_| PpkError::Malformed)?;
    Ok(out)
}

/// PPK v2's cipher key: two SHA-1 digests over a counter and the passphrase,
/// concatenated and truncated to 32 bytes.
fn derive_v2_cipher_key(passphrase: &str) -> Zeroizing<Vec<u8>> {
    use sha1::Digest;

    let mut key = Zeroizing::new(Vec::with_capacity(40));
    for sequence in 0u32..2 {
        let mut hash = Sha1::new();
        hash.update(sequence.to_be_bytes());
        hash.update(passphrase.as_bytes());
        key.extend_from_slice(&hash.finalize());
    }
    key.truncate(32);
    key
}

/// PPK v2's MAC key: SHA-1 over a fixed label and the passphrase (empty for an
/// unencrypted key).
fn v2_mac_key(passphrase: &str) -> Zeroizing<Vec<u8>> {
    use sha1::Digest;

    let mut hash = Sha1::new();
    hash.update(b"putty-private-key-file-mac-key");
    hash.update(passphrase.as_bytes());
    Zeroizing::new(hash.finalize().to_vec())
}

/// AES-256-CBC with no padding scheme: PuTTY pads the blob itself, to the block
/// size, and the padding is simply ignored by whoever reads the fields.
fn aes_cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Zeroizing<Vec<u8>>, PpkError> {
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return Err(PpkError::Malformed);
    }
    let mut buffer = Zeroizing::new(data.to_vec());
    let decryptor = Aes256CbcDec::new_from_slices(key, iv).map_err(|_| PpkError::Malformed)?;
    let length = decryptor
        .decrypt_padded_mut::<NoPadding>(&mut buffer)
        .map_err(|_| PpkError::Malformed)?
        .len();
    buffer.truncate(length);
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ppk::fixtures;
    use crate::app::ppk::parse::parse;

    #[test]
    fn unlocks_a_v3_encrypted_ed25519_key() {
        let f = parse(fixtures::ED25519_V3_ENC).unwrap();
        let plain = unlock(&f, fixtures::PASSPHRASE).expect("correct passphrase");
        // An ed25519 private blob is one SSH string of 32 bytes, possibly
        // followed by padding.
        assert_eq!(&plain[..4], &[0, 0, 0, 32]);
        assert!(plain.len() >= 36);
    }

    #[test]
    fn a_wrong_passphrase_is_reported_as_such() {
        let f = parse(fixtures::ED25519_V3_ENC).unwrap();
        // `matches!` rather than `assert_eq!`: the Ok side is key material, and
        // a failing equality assert would print it into the test log.
        assert!(matches!(
            unlock(&f, "not-it"),
            Err(PpkError::WrongPassphrase)
        ));
    }

    #[test]
    fn an_unencrypted_v3_key_verifies_without_a_passphrase() {
        let f = parse(fixtures::ED25519_V3_PLAIN).unwrap();
        let plain = unlock(&f, "").expect("no passphrase needed");
        assert_eq!(&plain[..4], &[0, 0, 0, 32]);
    }

    #[test]
    fn a_corrupt_unencrypted_key_is_damaged_not_wrong_passphrase() {
        let mut f = parse(fixtures::ED25519_V3_PLAIN).unwrap();
        f.private_blob[8] ^= 0xff;
        assert!(matches!(unlock(&f, ""), Err(PpkError::Damaged)));
    }

    #[test]
    fn a_comment_with_trailing_whitespace_verifies_with_its_real_mac() {
        // A real round trip through `unlock`, not just parsing: a parser that
        // trimmed the comment would still parse this file, but the MAC PuTTY
        // wrote was computed over the untrimmed comment, so verification
        // would fail and a correct (empty) passphrase would be reported as
        // wrong on an unencrypted key -- `Damaged`, per `unlock`'s contract.
        let modified = fixtures::ED25519_V3_PLAIN.replacen(
            "Comment: skillkeeper-test\n",
            "Comment: skillkeeper-test \n",
            1,
        );
        let mut f = parse(&modified).expect("parses");
        assert_eq!(f.comment, "skillkeeper-test ");

        // The fixture's own MAC was computed over the original comment, so it
        // no longer matches; replace it with the MAC this exact (untrimmed)
        // file would really carry, the same way `unlock` computes it.
        let data = mac_data(&f, &f.private_blob);
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&[]).expect("empty key is valid");
        mac.update(&data);
        f.mac = mac.finalize().into_bytes().to_vec();

        let plain = unlock(&f, "").expect("the real MAC for this comment must verify");
        assert_eq!(&plain[..4], &[0, 0, 0, 32]);
    }

    #[test]
    fn unlocks_v3_rsa_and_ecdsa() {
        for text in [
            fixtures::RSA_V3_ENC,
            fixtures::ECDSA_V3_ENC,
            fixtures::ECDSA_V3_P384,
        ] {
            let f = parse(text).unwrap();
            assert!(unlock(&f, fixtures::PASSPHRASE).is_ok(), "{}", f.algorithm);
        }
    }

    #[test]
    fn absurd_argon2_parameters_are_rejected_not_run() {
        let mut f = parse(fixtures::ED25519_V3_ENC).unwrap();
        f.kdf.as_mut().unwrap().memory_kib = 8_000_000; // 8 GiB
        assert!(matches!(
            unlock(&f, fixtures::PASSPHRASE),
            Err(PpkError::Malformed)
        ));
    }

    #[test]
    fn an_absurd_argon2_pass_count_is_rejected_not_run() {
        let mut f = parse(fixtures::ED25519_V3_ENC).unwrap();
        f.kdf.as_mut().unwrap().passes = u32::MAX;
        assert!(matches!(
            unlock(&f, fixtures::PASSPHRASE),
            Err(PpkError::Malformed)
        ));
    }

    #[test]
    fn an_absurd_argon2_parallelism_is_rejected_not_run() {
        let mut f = parse(fixtures::ED25519_V3_ENC).unwrap();
        f.kdf.as_mut().unwrap().parallelism = 4_000_000_000;
        assert!(matches!(
            unlock(&f, fixtures::PASSPHRASE),
            Err(PpkError::Malformed)
        ));
    }

    #[test]
    fn ssh_string_prefixes_the_length() {
        let mut out = Vec::new();
        ssh_string(&mut out, b"abc");
        assert_eq!(out, vec![0, 0, 0, 3, b'a', b'b', b'c']);
    }

    #[test]
    fn unlocks_a_v2_encrypted_key() {
        let f = parse(fixtures::ED25519_V2_ENC).unwrap();
        let plain = unlock(&f, fixtures::PASSPHRASE).expect("correct passphrase");
        assert_eq!(&plain[..4], &[0, 0, 0, 32]);
    }

    #[test]
    fn unlocks_an_unencrypted_v2_key() {
        let f = parse(fixtures::ED25519_V2_PLAIN).unwrap();
        assert!(unlock(&f, "").is_ok());
    }

    #[test]
    fn a_wrong_v2_passphrase_is_reported_as_such() {
        let f = parse(fixtures::ED25519_V2_ENC).unwrap();
        assert!(matches!(
            unlock(&f, "not-it"),
            Err(PpkError::WrongPassphrase)
        ));
    }

    #[test]
    fn unlocks_a_v2_rsa_key() {
        let f = parse(fixtures::RSA_V2_ENC).unwrap();
        assert!(unlock(&f, fixtures::PASSPHRASE).is_ok());
    }
}
