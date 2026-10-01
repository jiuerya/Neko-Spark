; 安装程序自定义脚本
; 目标：默认安装到 D 盘（若 D 盘存在），避免占用 C 盘；用户仍可手动更改安装目录。

!include LogicLib.nsh

!macro preInit
  SetRegView 64
  ${If} ${FileExists} "D:\*.*"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\GalleryMirror"
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\GalleryMirror"
  ${EndIf}
!macroend

; 覆盖升级前主动关闭主进程及其 Electron 子进程，避免 app.asar / native DLL 被占用。
; taskkill 找不到进程时返回非零，但不能阻断首次安装，所以这里故意忽略返回码。
!macro customInit
  nsExec::ExecToLog 'taskkill.exe /F /T /IM Neko_Spark.exe'
  nsExec::ExecToLog 'taskkill.exe /F /T /IM GalleryMirror.exe'
!macroend
