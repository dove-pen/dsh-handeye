# Disclaimer

HandEye performs real actions on a real computer: moving the mouse, typing, clicking coordinates,
reading the screen, automating browsers and background controls, and speaking text out loud.

## Automation can be wrong

- OCR misreads text. A click can land on the wrong control. A keyboard sequence can go to the wrong window.
- Acceptance checks reduce this risk; they do not remove it. A check can be satisfied while the
  real outcome is still wrong.
- You are responsible for what runs on your machine. Review what an agent is about to do, and keep
  the gate enabled. Do not disable confirmation for destructive actions on a machine you care about.

## No warranty

This software is provided "as is", without warranty of any kind, express or implied, including but not
limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.
In no event shall the authors be liable for any claim, damages or other liability arising from, out of
or in connection with the software or its use.

## Sensitive material

Do not point the tools at contents you would not want on disk: screenshots and OCR results are written
where the call asks them to be written, and episodes record what the tools saw. Use the redaction and
path guards, and delete `%LOCALAPPDATA%\dsh-handeye-plus` when you are done (see PRIVACY.md).
