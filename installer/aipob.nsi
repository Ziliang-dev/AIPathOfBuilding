Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetOverwrite on

!ifndef STAGING_PATH
  !error "STAGING_PATH define is required"
!endif
!ifndef OUTPUT_PATH
  !error "OUTPUT_PATH define is required"
!endif
!if /FileExists "${STAGING_PATH}\Path of Building.exe"
  !define POB_EXECUTABLE "Path of Building.exe"
!else if /FileExists "${STAGING_PATH}\Path{space}of{space}Building.exe"
  !define POB_EXECUTABLE "Path{space}of{space}Building.exe"
!else
  !define POB_EXECUTABLE "PathOfBuilding.exe"
!endif

Name "AIPathOfBuilding"
OutFile "${OUTPUT_PATH}"
InstallDir "$LOCALAPPDATA\Programs\AIPathOfBuilding"
InstallDirRegKey HKCU "Software\AIPathOfBuilding" "InstallDir"
ShowInstDetails show
ShowUninstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "AIPathOfBuilding" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${STAGING_PATH}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfSilent silent
  WriteRegStr HKCU "Software\AIPathOfBuilding" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPathOfBuilding" "DisplayName" "AIPathOfBuilding"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPathOfBuilding" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPathOfBuilding" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  CreateDirectory "$SMPROGRAMS\AIPathOfBuilding"
  CreateShortcut "$SMPROGRAMS\AIPathOfBuilding\AIPathOfBuilding.lnk" "$INSTDIR\${POB_EXECUTABLE}"
silent:
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\AIPathOfBuilding\AIPathOfBuilding.lnk"
  RMDir "$SMPROGRAMS\AIPathOfBuilding"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPathOfBuilding"
  DeleteRegKey HKCU "Software\AIPathOfBuilding"
  RMDir /r "$INSTDIR"
SectionEnd
