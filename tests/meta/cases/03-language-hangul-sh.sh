CASE_DESC="LANG-01: Hangul in a shell script comment"
GATE="scripts/check-language.sh"
EXPECT_PATTERN="LANG-01"
plant() { printf '#!/usr/bin/env bash\n# %s comment\n' "$(hangul)" > docs/snippet.sh; }
