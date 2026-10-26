!include "WinVer.nsh"

!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Guzi Scholar requires Windows 10 version 1903 (build 18362) or later."
    Quit
  ${EndIf}
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R0 < 18362
    MessageBox MB_OK|MB_ICONSTOP "Guzi Scholar requires Windows 10 version 1903 (build 18362) or later."
    Quit
  ${EndIf}
!macroend
