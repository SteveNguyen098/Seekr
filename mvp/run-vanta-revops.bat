@echo off
cd /d "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\mvp"
npx tsx src/index.ts --job-url "https://jobs.ashbyhq.com/vanta/cc1cbee0-06cf-4b63-b49c-945b1c12f657" --resume "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\Seekr Resume Template.docx" --out ./out/vanta --headed
pause
