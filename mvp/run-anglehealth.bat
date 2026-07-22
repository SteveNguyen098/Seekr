@echo off
cd /d "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\mvp"
npx tsx src/index.ts --job-url "https://jobs.ashbyhq.com/anglehealth/6bdb1829-de5c-45be-aded-ef1522cf6643" --resume "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\Seekr Resume Template.docx" --out ./out/anglehealth --headed
pause
