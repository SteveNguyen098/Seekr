@echo off
cd /d "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\mvp"
npx tsx src/index.ts --job-url "https://jobs.ashbyhq.com/ramp/16fb536d-fe10-4ea7-8956-d6d0cbddd6f5" --resume "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\Seekr Resume Template.docx" --out ./out/ramp --headed
pause
