CASE_DESC="TMPL-01: a ticket missing a required section is blocked"
GATE="scripts/check-templates.sh"
EXPECT_PATTERN="TMPL-01"
plant() {
  cat > .docs/tickets/_TICKET_TEMPLATE.md <<'MD'
# <ONT-###> — <Title>

## 1. Goal
<goal>

## 2. Scope
<scope>

## 3. Acceptance Criteria
<ac>
MD
  cat > .docs/tickets/ONT-777_bad.md <<'MD'
# ONT-777 — Bad

## 1. Goal
present

## 3. Acceptance Criteria
present
MD
}
