; Mortiflix Studio NSIS hooks (Tauri 2 bundle.windows.nsis.installerHooks, v2.tauri.app/distribute/windows-installer).
; An update or reinstall must not keep files of the build before it: Tauri's installer copies the new files over the
; old ones and its uninstaller removes only the files of its own build, so hashed UI chunks and removed service files
; of older builds piled up (VM 2026-11-03: 1220 files in app\web\app\assets where the build has 58).
; These five folders hold only what the installer ships; the studio's own data lives in the user's Mortiflix folder.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\service"
  RMDir /r "$INSTDIR\renderer"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\ffmpeg"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\service"
  RMDir /r "$INSTDIR\renderer"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\ffmpeg"
!macroend
