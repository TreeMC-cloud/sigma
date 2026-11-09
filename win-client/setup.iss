; Sigma Windows 客户端安装包配置
;
; 为什么用 Inno Setup：它是 Windows 上最成熟的小型安装器，
; 单文件安装程序、不需要 MSI 基础设施，GitHub 的 windows runner 一条 choco 命令就能装。
;
; 注意：这个安装器**只打包 SigmaClient.exe 一个文件**。
; 因为 exe 里已经内置了 Node 运行时，所以不需要额外分发任何依赖。

[Setup]
AppName=Sigma 客户端
AppVersion=1.0.0
AppPublisher=Sigma
AppId={{8F3A2C1E-4B7D-4A9E-9C2B-5D6E7F8A9B0C}

; 默认装到 Program Files；普通用户也可以装（PrivilegesRequired=lowest 时自动退回用户目录）
DefaultDirName={autopf}\SigmaClient
DefaultGroupName=Sigma
DisableProgramGroupPage=yes

; 输出
OutputBaseFilename=SigmaSetup
OutputDir=Output
Compression=lzma2
SolidCompression=yes

; 只支持 64 位：内核是 Node 22 的 x64 二进制
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName=Sigma 客户端

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务"
Name: "autostart"; Description: "开机自动启动"; GroupDescription: "附加任务"

[Files]
Source: "SigmaClient.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Sigma 客户端"; Filename: "{app}\SigmaClient.exe"
Name: "{group}\卸载 Sigma 客户端"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Sigma 客户端"; Filename: "{app}\SigmaClient.exe"; Tasks: desktopicon

[Registry]
; 开机自启用 HKCU 而不是 HKLM：装的时候可能没提权，写 HKCU 一定成功
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "SigmaClient"; ValueData: """{app}\SigmaClient.exe"""; \
  Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\SigmaClient.exe"; Description: "立即启动 Sigma 客户端"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时把用户配置（令牌）也删掉，避免重装后旧令牌残留
Type: files; Name: "{app}\config.json"
