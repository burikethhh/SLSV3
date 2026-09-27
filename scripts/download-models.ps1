# Downloads YuNet + EdgeFace-XXS into desktop/models/ (git-ignored, never bundled in repo).
$models = Join-Path $PSScriptRoot "..\desktop\models"
New-Item -ItemType Directory -Force -Path $models | Out-Null
Write-Host "Fetching YuNet (detection, ~200KB)..."
Invoke-WebRequest -Uri "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" -OutFile (Join-Path $models "face_detection_yunet_2023mar.onnx")
Write-Host "Fetching EdgeFace-XXS (recognition, ~4.9MB, 512-d)..."
Invoke-WebRequest -Uri "https://github.com/yakhyo/edgeface-onnx/releases/download/weights/edgeface_xxs.onnx" -OutFile (Join-Path $models "edgeface_xxs.onnx")
Get-ChildItem $models
Write-Host "Done. Re-tune cosine threshold from 0.40 on your gym data (do NOT reuse SFace 0.62)."
