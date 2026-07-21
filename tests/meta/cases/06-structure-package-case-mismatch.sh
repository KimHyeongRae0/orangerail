CASE_DESC="ST-02: packages registry is exact-match — a near-miss name (Core) is unregistered"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-02"
plant() { mkdir -p packages/Core; }
