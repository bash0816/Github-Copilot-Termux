# Third-Party Notices

This package includes third-party software with the following licenses.

---

## GitHub Copilot CLI

- Source: https://github.com/github/copilot-cli (private)
- Version: 1.0.63
- License: GitHub Copilot CLI License
- License text: THIRD-PARTY-LICENSES/COPILOT-LICENSE.md

Redistributed in unmodified form as part of this package, in accordance with
Section 2 of the GitHub Copilot CLI License.

Files: lib/copilot/

---

## Node.js

- Source: https://nodejs.org/
- License: MIT (main), with bundled components under various licenses
  (see THIRD-PARTY-LICENSES/NODE-LICENSE.txt for full attribution)
- License text: THIRD-PARTY-LICENSES/NODE-LICENSE.txt

Files: lib/node

---

## GNU C Library (glibc)

- Source: https://www.gnu.org/software/libc/
- License: LGPL-2.1+
- License text: THIRD-PARTY-LICENSES/LGPL-2.1.txt

Files:
  lib/glibc/ld-linux-aarch64.so.1
  lib/glibc/libc.so.6
  lib/glibc/libm.so.6

---

## GCC Runtime Libraries

- Source: https://gcc.gnu.org/
- License: GPL-3.0 WITH GCC Runtime Library Exception
- Exception text: THIRD-PARTY-LICENSES/GCC-RUNTIME-EXCEPTION.txt
- Base license text: THIRD-PARTY-LICENSES/GPL-3.0.txt

Files:
  lib/glibc/libgcc_s.so.1
  lib/glibc/libstdc++.so.6
