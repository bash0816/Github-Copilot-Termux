# Third-Party Notices

This package includes third-party software with the following licenses.

---

## GitHub Copilot CLI

- Source: https://github.com/github/copilot-cli (private)
- Package: @github/copilot-linux-arm64
- License: GitHub Copilot CLI License
- License text: THIRD-PARTY-LICENSES/COPILOT-LICENSE.md

Not bundled in this npm package. Downloaded in unmodified form at
`copilot-termux setup` time from the npm registry, in accordance with
Section 2 of the GitHub Copilot CLI License. The exact version fetched is
pinned in `config/manifest.json` (`copilot.version`), and the downloaded
binary is cached under `~/.copilot-termux/<version>/copilot`.

---

## GNU C Library (glibc)

- Source: https://www.gnu.org/software/libc/
- License: LGPL-2.1+
- License text: THIRD-PARTY-LICENSES/LGPL-2.1.txt

Not bundled in this npm package. Copied at `copilot-termux setup` time from
the system `glibc-repo` package (`pkg install glibc-repo && pkg install
glibc`) into `~/.copilot-termux/glibc-wrap-libs/`:
  ld-linux-aarch64.so.1
  libc.so.6

---

## GCC Runtime Libraries

- Source: https://gcc.gnu.org/
- License: GPL-3.0 WITH GCC Runtime Library Exception
- Exception text: THIRD-PARTY-LICENSES/GCC-RUNTIME-EXCEPTION.txt
- Base license text: THIRD-PARTY-LICENSES/GPL-3.0.txt

Not bundled in this npm package. Copied at `copilot-termux setup` time from
the system `glibc-repo` package into `~/.copilot-termux/glibc-wrap-libs/`:
  libgcc_s.so.1
