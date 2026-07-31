' Launches the Seekr desktop app with no console window.
' Double-click this (or the Desktop shortcut that points at it).
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
shell.Run """" & here & "\node_modules\.bin\electron.cmd"" .", 0, False
