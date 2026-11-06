---
'@ghia/native': patch
---

A scroll translate writes the translated operations of each row straight into their places in the frame instead of collecting those of every row into vectors and copying them over, and a translate that declines still writes nothing. In the mailbox scroll proxy a patched tick went from 6.4M to 5.4M instructions.
