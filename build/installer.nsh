; Questboard installer safety net (electron-builder picks this file up as build/installer.nsh).
;
; An update first removes the old version and only then unpacks the new one. If that is cut off
; (PC shut down or restarted mid-update, installer killed), the user was left with no app at all
; (0.6.2, 2026-11-08). So:
;  1. customInit: before anything is removed, register a one-time "repair" at the next sign-in
;     (HKCU RunOnce) that runs this same installer again. customInstall deletes it once the new
;     files are in place, so it only ever fires when an install did not finish. The repair run
;     passes --qb-repair and does not register itself again (no endless loop).
;  2. customRemoveFiles: when the uninstaller runs as part of an update, it keeps the old files.
;     The new version is copied over them, so a cut-off update still leaves a working app.
;     (Applies to updates from 0.6.4 on; 1. also covers updates from older versions.)
; Board data never lives here: it is in Documents\Questboard and no installer touches it.

!include FileFunc.nsh

!define QB_RUNONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define QB_RUNONCE_VALUE "QuestboardRepair"

!macro customInit
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "--qb-repair" $R8
  ${If} ${Errors}
    WriteRegStr HKCU "${QB_RUNONCE_KEY}" "${QB_RUNONCE_VALUE}" '"$EXEPATH" /S --force-run --qb-repair'
  ${EndIf}
  ClearErrors
!macroend

!macro customInstall
  DeleteRegValue HKCU "${QB_RUNONCE_KEY}" "${QB_RUNONCE_VALUE}"
!macroend

!macro customRemoveFiles
  ${IfNot} ${isUpdated}
    ; a real uninstall: remove the program files (never the board in Documents\Questboard)
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${EndIf}
!macroend
