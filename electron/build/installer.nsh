; BlockWhiz v1.7.0 - coexistence with legacy CraftMate shortcuts.
;
; Legacy CraftMate (installer/Setup.cs) creates Desktop\BlockWhiz.lnk pointing to
; %LOCALAPPDATA%\Programs\CraftMate\CraftMate.exe. electron-builder would
; unconditionally overwrite that file on install and delete it on uninstall.
;
; Strategy (no persistent state required):
;  - BWParkForeignDesktop runs in .onInit (installer) / un.onInit (uninstaller),
;    BEFORE any file, registry or shortcut change:
;      * If Desktop\<ShortcutName>.lnk exists, resolve TargetPath via
;        WScript.Shell (PowerShell). "OURS" = target contains craftmate-desktop;
;        anything else (or probe failure) = FOREIGN.
;      * FOREIGN: park it to a unique <name>.lnk.bwkeepN name and VERIFY the
;        rename (source gone, destination exists). On any failure ABORT the
;        whole install/uninstall - the foreign shortcut is never overwritten
;        or deleted.
;      * If the .lnk is missing but a stale .bwkeepN exists (previous crash),
;        restore the first one found (it only ever holds a foreign shortcut).
;  - customInstall (after stock addDesktopLink): remove the desktop shortcut
;    just created and restore the parked foreign one.
;  - customUnInstall (after stock deletions): restore the parked shortcut.
;
; Start Menu shortcuts do not collide (ours: Programs\BlockWhiz.lnk,
; legacy: Programs\BlockWhiz\*.lnk subfolder) and are left untouched.

Var BWParked
Var BWKeepPath

; Probe Desktop\${SHORTCUT_NAME}.lnk target; result in $R7 = "OURS" or "FOREIGN".
!macro BWProbeDesktopLink
  FileOpen $R8 "$TEMP\bw_getlnk.ps1" w
  FileWrite $R8 'param($$LnkPath,$$OutFile)$$ws=New-Object -ComObject WScript.Shell;$$t=$$ws.CreateShortcut($$LnkPath).TargetPath;$$v="FOREIGN";if($$t -and $$t -match "craftmate-desktop"){$$v="OURS"};[IO.File]::WriteAllText($$OutFile,$$v)'
  FileClose $R8
  Delete "$TEMP\bw_lnk_verdict.txt"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$TEMP\bw_getlnk.ps1" -LnkPath "$DESKTOP\${SHORTCUT_NAME}.lnk" -OutFile "$TEMP\bw_lnk_verdict.txt"'
  ClearErrors
  FileOpen $R9 "$TEMP\bw_lnk_verdict.txt" r
  ${IfNot} ${Errors}
    FileRead $R9 $R7
    FileClose $R9
  ${Else}
    StrCpy $R7 "FOREIGN"
  ${EndIf}
!macroend

; Abort before any install/uninstall change (.onInit runs prior to sections,
; so nothing has been modified yet). The foreign shortcut and all legacy
; CraftMate data remain untouched.
!macro BWAbortProtect
  ${IfNot} ${Silent}
    MessageBox MB_ICONSTOP|MB_TOPMOST|MB_SETFOREGROUND "BlockWhiz cannot continue: the existing desktop shortcut could not be preserved safely. No changes were made. Please close other installers and retry." /SD IDOK
  ${EndIf}
  SetErrorLevel 2
  Quit
!macroend

; Suffix for backup slot $R6 (1..9): 1 -> "bwkeep", n -> "bwkeep<n>"
!macro BWSuffixForSlot
  ${If} $R6 == 1
    StrCpy $R7 "bwkeep"
  ${Else}
    StrCpy $R7 "bwkeep$R6"
  ${EndIf}
!macroend

; Find a free backup name -> $BWKeepPath (slots: bwkeep, bwkeep2 .. bwkeep9)
!macro BWFindKeepPath
  StrCpy $R6 0
bw_next_keep:
  IntOp $R6 $R6 + 1
  !insertmacro BWSuffixForSlot
  StrCpy $BWKeepPath "$DESKTOP\${SHORTCUT_NAME}.lnk.$R7"
  ${IfNot} ${FileExists} $BWKeepPath
    Goto bw_got_keep
  ${EndIf}
  ${If} $R6 >= 9
    !insertmacro BWAbortProtect
  ${EndIf}
  Goto bw_next_keep
bw_got_keep:
!macroend

; Park a FOREIGN desktop shortcut aside. Aborts the whole process on failure.
; On success $BWParked = "1" and $BWKeepPath holds the backup path.
!macro BWParkForeignDesktop
  StrCpy $BWParked "0"
  StrCpy $BWKeepPath ""
  ; Phase 1: if the shortcut is missing but a stale backup exists (previous
  ; crash), restore the first one found - it only ever holds a foreign
  ; shortcut. It is then re-probed and re-parked below like any foreign lnk.
  ${IfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    StrCpy $R6 0
bw_restore_next:
    IntOp $R6 $R6 + 1
    !insertmacro BWSuffixForSlot
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk.$R7"
      Rename "$DESKTOP\${SHORTCUT_NAME}.lnk.$R7" "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Goto bw_probe_lnk
    ${EndIf}
    ${If} $R6 < 9
      Goto bw_restore_next
    ${EndIf}
    Goto bw_park_done
  ${EndIf}
bw_probe_lnk:
  ; Phase 2: probe the (possibly just-restored) shortcut and park if FOREIGN
  ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    !insertmacro BWProbeDesktopLink
    ${If} $R7 == "FOREIGN"
      !insertmacro BWFindKeepPath
      Rename "$DESKTOP\${SHORTCUT_NAME}.lnk" $BWKeepPath
      ${If} ${Errors}
        !insertmacro BWAbortProtect
      ${EndIf}
      ; verify: source must be gone and backup must exist
      ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
        !insertmacro BWAbortProtect
      ${EndIf}
      ${IfNot} ${FileExists} $BWKeepPath
        !insertmacro BWAbortProtect
      ${EndIf}
      StrCpy $BWParked "1"
    ${EndIf}
  ${EndIf}
bw_park_done:
!macroend

!macro customInit
  !insertmacro BWParkForeignDesktop
!macroend

!macro customInstall
  ${If} $BWParked == "1"
    ; drop the desktop shortcut this installer just created
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    ; restore the foreign shortcut under its original name
    ${If} ${FileExists} $BWKeepPath
      ${IfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
        Rename $BWKeepPath "$DESKTOP\${SHORTCUT_NAME}.lnk"
        ${If} ${Errors}
          ${IfNot} ${Silent}
            MessageBox MB_ICONEXCLAMATION|MB_TOPMOST "The preserved desktop shortcut was kept as $BWKeepPath." /SD IDOK
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

!macro customUnInit
  !insertmacro BWParkForeignDesktop
!macroend

!macro customUnInstall
  ${If} $BWParked == "1"
    ${If} ${FileExists} $BWKeepPath
      ${IfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
        Rename $BWKeepPath "$DESKTOP\${SHORTCUT_NAME}.lnk"
      ${EndIf}
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
