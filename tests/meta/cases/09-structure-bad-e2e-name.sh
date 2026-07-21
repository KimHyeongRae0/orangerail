CASE_DESC="ST-05: e2e scenario without a ONT-### ticket-ID prefix"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-05"
plant() { printf '#!/usr/bin/env bash\nexit 0\n' > tests/e2e/random.sh; chmod +x tests/e2e/random.sh; }
