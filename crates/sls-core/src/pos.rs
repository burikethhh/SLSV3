//! POS math in **integer cents** — the v3 optimization.
//! v2 used floats in places + full-table scans per keystroke.
//! Here: single-pass totals, no float drift, UI virtualizes + debounces.

/// Money in minor units (cents). Never use f64 for money.
pub type Money = i64;

#[derive(Debug, Clone)]
pub struct CartLine {
    pub product_id: String,
    pub unit_cents: Money,
    pub qty: u32,
    /// Per-line discount in cents (clamped to line total).
    pub discount_cents: Money,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayMethod {
    Cash,
    Card,
    Gcash,
}

/// Pure checkout: returns (total_cents, change_cents) or an error string.
/// Optimized: one pass, saturating arithmetic, no allocation.
pub fn checkout(lines: &[CartLine], tendered_cents: Money, _method: PayMethod) -> Result<(Money, Money), &'static str> {
    if lines.is_empty() {
        return Err("empty cart");
    }
    let mut total: Money = 0;
    for l in lines {
        if l.qty == 0 {
            continue;
        }
        let gross = l.unit_cents.saturating_mul(l.qty as Money);
        let net = gross.saturating_sub(l.discount_cents.max(0).min(gross));
        total = total.saturating_add(net);
    }
    if total <= 0 {
        return Err("non-positive total");
    }
    if tendered_cents < total {
        return Err("insufficient tender");
    }
    Ok((total, tendered_cents - total))
}

/// Whole-cart percentage discount (recycled from orig `checkout_pos_sale`
/// `discount_pct` path, but in cents: `pct` clamped 0..100, rounded half-up).
/// v2 applied floats per line; v3 computes on the integer subtotal once.
pub fn apply_pct_discount(subtotal_cents: Money, pct: f64) -> Money {
    if subtotal_cents <= 0 {
        return 0;
    }
    let pct = pct.clamp(0.0, 100.0);
    let off = ((subtotal_cents as f64 * pct / 100.0).round() as Money).max(0).min(subtotal_cents);
    subtotal_cents - off
}

/// Case-insensitive substring match for debounced product search.
/// Caller debounces (150ms) + caps results (e.g. 50) + uses SQLite FTS/LIKE index.
pub fn matches_query(name: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    name.to_lowercase().contains(&query.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkout_basic() {
        let lines = vec![
            CartLine { product_id: "a".into(), unit_cents: 15000, qty: 2, discount_cents: 0 },
            CartLine { product_id: "b".into(), unit_cents: 5000, qty: 1, discount_cents: 500 },
        ];
        // 30000 + (5000-500) = 34500
        assert_eq!(checkout(&lines, 34500, PayMethod::Cash), Ok((34500, 0)));
        assert_eq!(checkout(&lines, 40000, PayMethod::Gcash), Ok((34500, 5500)));
    }
    #[test]
    fn checkout_rejects() {
        assert!(checkout(&[], 100, PayMethod::Cash).is_err());
        let lines = vec![CartLine { product_id: "a".into(), unit_cents: 100, qty: 1, discount_cents: 0 }];
        assert!(checkout(&lines, 50, PayMethod::Cash).is_err());
    }
    #[test]
    fn pct_discount_cents() {
        assert_eq!(apply_pct_discount(10000, 10.0), 9000);
        assert_eq!(apply_pct_discount(10000, 0.0), 10000);
        assert_eq!(apply_pct_discount(10000, 100.0), 0);
        assert_eq!(apply_pct_discount(10000, 150.0), 0); // clamped
        assert_eq!(apply_pct_discount(0, 10.0), 0);
    }
}
