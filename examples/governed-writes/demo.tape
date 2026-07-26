# VHS tape for the governed-writes walkthrough GIF.
#
# Renders examples/governed-writes/walkthrough.mjs to demo.gif deterministically —
# no live screen recording. Requires vhs + its ttyd/ffmpeg deps:
#   brew install vhs        # (macOS)  — pulls ttyd + ffmpeg
# Prep the example once, then render:
#   npm install && npx prisma generate --schema prisma/schema.prisma \
#     && npx prisma db push --schema prisma/schema.prisma
#   vhs demo.tape           # -> demo.gif
#
# Height/FontSize are tuned so the full ~34-line run fits; adjust if your theme's
# metrics differ.

Output demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1120
Set Height 670
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# Silent setup — a clean audit store so the run starts from zero (not recorded).
Hide
Type "export DATABASE_URL='file:./dev.db'; rm -rf .orangerail; clear"
Enter
Show

Type "node walkthrough.mjs"
Sleep 600ms
Enter
Sleep 10s
