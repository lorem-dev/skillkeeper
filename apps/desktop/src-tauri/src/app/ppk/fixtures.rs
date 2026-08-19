//! PPK test fixtures, embedded at compile time. Test-only: see
//! `testdata/README.md` for what they are and how to regenerate them.

/// The passphrase every encrypted fixture was created with.
pub const PASSPHRASE: &str = "skillkeeper-test";

pub const ED25519_V3_ENC: &str = include_str!("testdata/ed25519-v3-enc.ppk");
pub const ED25519_V3_ENC_OPENSSH: &str = include_str!("testdata/ed25519-v3-enc.openssh");
pub const ED25519_V3_PLAIN: &str = include_str!("testdata/ed25519-v3-plain.ppk");
pub const ED25519_V3_PLAIN_OPENSSH: &str = include_str!("testdata/ed25519-v3-plain.openssh");
pub const ED25519_V2_ENC: &str = include_str!("testdata/ed25519-v2-enc.ppk");
pub const ED25519_V2_ENC_OPENSSH: &str = include_str!("testdata/ed25519-v2-enc.openssh");
pub const ED25519_V2_PLAIN: &str = include_str!("testdata/ed25519-v2-plain.ppk");
pub const ED25519_V2_PLAIN_OPENSSH: &str = include_str!("testdata/ed25519-v2-plain.openssh");
pub const RSA_V3_ENC: &str = include_str!("testdata/rsa-v3-enc.ppk");
pub const RSA_V3_ENC_OPENSSH: &str = include_str!("testdata/rsa-v3-enc.openssh");
pub const RSA_V2_ENC: &str = include_str!("testdata/rsa-v2-enc.ppk");
pub const RSA_V2_ENC_OPENSSH: &str = include_str!("testdata/rsa-v2-enc.openssh");
pub const ECDSA_V3_ENC: &str = include_str!("testdata/ecdsa-v3-enc.ppk");
pub const ECDSA_V3_ENC_OPENSSH: &str = include_str!("testdata/ecdsa-v3-enc.openssh");
pub const ECDSA_V3_PLAIN: &str = include_str!("testdata/ecdsa-v3-plain.ppk");
pub const ECDSA_V3_PLAIN_OPENSSH: &str = include_str!("testdata/ecdsa-v3-plain.openssh");
pub const ECDSA_V3_P384: &str = include_str!("testdata/ecdsa-v3-p384.ppk");
pub const ECDSA_V3_P384_OPENSSH: &str = include_str!("testdata/ecdsa-v3-p384.openssh");
pub const ECDSA_V3_P521: &str = include_str!("testdata/ecdsa-v3-p521.ppk");
pub const ECDSA_V3_P521_OPENSSH: &str = include_str!("testdata/ecdsa-v3-p521.openssh");
pub const DSA_V2_PLAIN: &str = include_str!("testdata/dsa-v2-plain.ppk");
pub const DSA_V2_ENC: &str = include_str!("testdata/dsa-v2-enc.ppk");
