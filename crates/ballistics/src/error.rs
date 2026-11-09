use core::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum BallisticsError {
    /// An input value is missing, non-finite or out of its physical range.
    InvalidInput(String),
    /// The zeroing iteration could not find a bore angle (e.g. zero range beyond reach).
    ZeroNotFound(String),
}

impl fmt::Display for BallisticsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BallisticsError::InvalidInput(m) => write!(f, "invalid input: {m}"),
            BallisticsError::ZeroNotFound(m) => write!(f, "zero not found: {m}"),
        }
    }
}

impl std::error::Error for BallisticsError {}

pub(crate) fn require(cond: bool, msg: impl Into<String>) -> Result<(), BallisticsError> {
    if cond {
        Ok(())
    } else {
        Err(BallisticsError::InvalidInput(msg.into()))
    }
}

pub(crate) fn positive(v: f64, name: &str) -> Result<(), BallisticsError> {
    require(v.is_finite() && v > 0.0, format!("{name} must be a positive number (got {v})"))
}

pub(crate) fn finite(v: f64, name: &str) -> Result<(), BallisticsError> {
    require(v.is_finite(), format!("{name} must be a finite number (got {v})"))
}
