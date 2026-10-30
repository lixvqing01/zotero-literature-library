$ErrorActionPreference = 'Stop'
if (Get-Process WINWORD -ErrorAction SilentlyContinue) { throw 'An existing Word process is running; isolated native integration test not started.' }
$citationWord = New-Object -ComObject Word.Application
$citationWord.Visible = $false
$citationWord.DisplayAlerts = 0
$citationDoc = $citationWord.Documents.Add()
$citationDoc.Content.Text = "Literature Library native integration fixture`r`r"
$citationDoc.SaveAs2((Join-Path (Get-Location) 'test-output\native-citation-test.docx'))
$citationWord.Selection.EndKey(6) | Out-Null
Set-Content -LiteralPath '.test-profile\run-word-test' -Value 'self-created fixture only'
Write-Output 'Created isolated Word citation test document'
