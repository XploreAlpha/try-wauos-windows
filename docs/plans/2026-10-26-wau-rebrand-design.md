# Wau rebrand — design

Date: 2026-10-26. Scope: the Windows launcher UI only. The guest desktop
stays Omarchy.

## Goal

Users of the launcher see "Wau" and nothing else that carries the Omarchy
brand. The product keeps working on existing installations.

## Decisions

| Question | Decision |
|---|---|
| How far does the rename reach? | Launcher UI (host side) only. The VM still runs Omarchy 4.0.4, whose shell, menus and themes are unchanged. |
| What is the new name? | `Try Omarchy` → `Try Wau`. A bare `Omarchy` → `Wau`. The "Try" prefix survives. |
| What happens to the About box? | Brand becomes Try Wau, but the MIT copyright notice stays verbatim and the dependency line stays: "Built with Omarchy, Arch Linux and QEMU". The MIT notice is the only place end users see the licence, because `LICENSE` is not embedded in the exe. |
| Data directory name? | `%LOCALAPPDATA%\TryOmarchy` → `%LOCALAPPDATA%\TryWau`, with a one-shot migration of existing installs. |
| Toolchain? | No installs on the review machine. The icon pipeline ships as a script; the user runs it on their own machine. |

## How the icon actually reaches the exe

`app/icon.ico` and `app/versioninfo.rc` are inputs, not outputs. Go's linker
only picks up a committed `.syso`; it does not compile `.rc` at build time, and
no script in this repository regenerates the syso. The committed
`app/rsrc_windows_amd64.syso` is therefore the only thing that decides the
icon and the version block in `TryOmarchy.exe`.

Verified: the 16x16 bitmap inside `rsrc_windows_amd64.syso` at offset 536 is
byte-identical to the one in `icon.ico` at offset 70, and the syso carries the
three UTF-16 "Try Omarchy" strings from `versioninfo.rc`.

Replacing the SVG and the ICO alone changes nothing in the exe. The syso must
be rebuilt:

```
llvm-rc /FO rsrc.res versioninfo.rc
llvm-cvtres /MACHINE:X64 /OUT:rsrc_windows_amd64.syso rsrc.res
rm rsrc.res
```

## Change inventory

### A. Brand constants

| Location | Change |
|---|---|
| `app/main.go:31` | `appTitle` "Try Omarchy" → "Try Wau" |
| `app/data_location.go:21` | `defaultDataDirectoryName` "TryOmarchy" → "TryWau" |
| `app/clipboard_files_windows.go:27` | clipboard cache folder "TryOmarchy" → "TryWau" |

`appTitle` also drives the QEMU `-name`, the VM window title, the per-display
titles ("Try Wau display 2"), the tray tooltip and the taskbar name. The
display-index matcher at `app/displays.go:78` builds its prefix from the same
constant, so the two stay in step.

### B. Message catalogs

`app/ui-locales/en.json` (230 hits), `app/ui-locales/zh-Hans.json` (256 hits),
`app/ui-locales/ko.json`. No Hangul or Chinese transliteration exists, so one
rule covers all three.

### C. User-visible Go literals

| Location | Visible as |
|---|---|
| `app/uninstall.go:23,25` | Apps & features display name |
| `app/shell_link_windows.go:144` | Start menu and desktop shortcut names |
| `app/launcher_windows.go:136,210` | `Start Omarchy.lnk` in the data folder |
| `app/portable_create.go:80` | `Start Omarchy.cmd` in a portable copy |
| `app/move_windows.go:166`, `app/recovery_windows.go:194,272` | the same names after a move or restore |
| `app/approved_url_schemes_windows.go:168,322` | registry protocol label |
| `app/hello_webauthn_windows.go:255,259` | Windows Hello relying party and prompt |
| `app/displays.go:41` | guest display name |
| `app/checkpoints_windows.go:161` | snapshot folder prefix |
| `app/boot_settings_windows.go:66,75` | settings notes |
| `app/forward.go:66`, `app/lan_firewall.go:134` | error text |
| `app/file_drop_qemu_windows.go:40`, `app/hello_webauthn_windows.go:222` | error text |
| `app/download_proxy_windows.go:117` | proxy user agent |
| `app/main.go:152-191` | `-help` output |

### D. Deliberately unchanged

| Location | Why |
|---|---|
| `app/hello_protocol.go:24` | `helloRelyingPartyID = "try-omarchy.invalid"` is the WebAuthn scope. Renaming it invalidates every enrolled credential. |
| `app/uninstall.go:15,18` | The registry key `TryOmarchy`. Renaming it orphans the Apps & features entry and blocks uninstall. |
| `app/cmd/sign-update/main.go:67,139` | The update manifest pins the asset name `TryOmarchy.exe`. Renaming the exe breaks the release pipeline and the update chain. |
| Window class names | `TryOmarchySetup`, `TryOmarchySnapshots`, `TryOmarchyChoice`, `TryOmarchyFileDrops`, `TryOmarchyLANForward` are not shown to users. |
| `app/go.mod` module path, guest paths | Technical identifiers, not UI. |
| `about.body` copyright line | MIT requires the notice verbatim. |

## Exception rules for the catalogs

1. `Try Omarchy contributors` in the About box stays verbatim.
2. `Try Omarchy` → `Try Wau`, then any remaining `Omarchy` → `Wau`.
3. Sentences that name a label the guest still shows get reworded instead of
   renamed, so the launcher does not point at a menu entry that does not
   exist:
   - "use Update > Omarchy inside the desktop" → "use Update inside the
     desktop" (the guest menu is still Omarchy's).
   - "Explorer or Omarchy Files" → "Explorer or the guest's file manager".
   - "can be launched from Omarchy" / "appear in Omarchy" → "from the guest" /
     "appear in the guest", because the guest's own launcher is still
     Omarchy's.

## Migration

### Data directory

`resolveStandardDataDirectory` resolves in this order: explicit `-dir`, the
remembered pointer in `<default>/data-location.json`, the default directory,
then the first-run chooser. Renaming the default directory would strand an
install that lives on another drive, because its pointer file lives inside the
old default directory.

One-shot migration, before the normal resolution:

1. Compute the new default directory (`%LOCALAPPDATA%\TryWau`) and the legacy
   one (`%LOCALAPPDATA%\TryOmarchy`).
2. If the new default is unclaimed and the legacy directory holds a complete
   install, rename the legacy directory to the new name. The pointer file
   moves with it, so an install on another drive is still found.
3. If the rename fails (the directory is in use, for example a running QEMU),
   fall back to using the legacy directory as the install location and write a
   pointer in the new default directory so later launches find it. The
   directory keeps its old name in this case; the launcher stays functional.

The rename only runs when the new default directory is unclaimed, so a user
who already created `TryWau` by hand is never overwritten.

### Shortcuts

Existing installations have `Try Omarchy.lnk`, `Try Omarchy Settings.lnk`,
`Start Omarchy.lnk` and `Start Omarchy.cmd` on disk. After the rename the new
shortcuts use the new names and the old ones would linger, so users would
still see "Omarchy" in the Start menu.

After writing the new shortcuts, delete the legacy-named ones, but only when
`readShellLink` shows they point at this installation's own executable. The
ownership check already exists in `app/shell_link_windows.go` and is reused
rather than reinvented.

## Delivered script

`scripts/branding/build-icon.mjs` renders the SVG to the four ICO sizes and
rebuilds the syso. It is run on the user's own machine, where the LLVM
toolchain and Go live. The script fails loudly if the resulting syso does not
contain the expected resources, so a silent no-op is impossible.

## Verification

- `go test ./...` — `app/versioninfo_test.go` fails the build if the syso and
  `currentVersion` drift apart, and if the syso stops carrying the version.
- `go vet ./...` and the Windows cross-vet.
- `go build` and inspect the produced exe's icon and version block.
- Grep the tree for leftover `Omarchy` outside the deliberate exceptions.
- Walk the UI: splash, settings, tray, About, error dialogs, the recovery
  walkthrough, the install walkthrough.

## Out of scope

- The guest desktop. Omarchy's own shell, menus, themes and app names keep
  their branding.
- The `TryOmarchy.exe` file name and the release asset names.
- The Omarchy icon mark itself, until a Wau mark exists.
