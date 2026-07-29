What is this? Seekr is a desktop-app and extension that monitors company career pages daily, matches jobs based on user preferences/filters, and auto-apply to those jobs using custom made documents. 
Who is it for? For actively-seeking job professionals who want to apply to certain companies of their choosing, but do not have the time nor energy to do so. People who are actively looking for a new job but cannot provide the necessary output to apply to dozens of jobs per day. 
What problem does it solve? It solves the problem of constantly applying to specific jobs daily for those who lack the time and/or the energy to do so, essentially reducing job applications “fatigue” that many desperate job seekers tend to face in this competitive job market. 
What does it do (MVP Section)? A standard version allows auto-applies to specific jobs from 10 different links that connect to different company/career portals. Seekr would scan and monitor these links daily and between the different sites, will choose the top jobs for the user and their background/preferences, this will be shown on the dashboard (it’ll look like a job board site/service but not quite, the familiar format is what we’re seeking). Seekr would use an AI generated resume template (provided by the user, a working usable resume) via automated systems from a dashboard to auto apply. Seekr would also bypasses specific job applications aspects, as there are plans to effectively auto-create accounts for certain job application portals as well as auto-answering unique, non-typical job related questions found within the process of applying to certain roles/companies. Once the resume is created for the that job application, it will be downloaded as a PDF file on a folder on the user’s PC, locally. Additionally, auto applied jobs will be logged and documented. This storage feature can be expanded into cloud sync as a premium feature. 
-	7/13 update: attempting to create a working prototype via Claude code, at the very least attempting to give it 1 link, parse the resume and relevant information, as well as create/alter a resume template from the job description.
o	Discussed about implementation BitWarden, a well-known password/account manager, into Seekr to nearly automate the account creation process for certain job boards. BitWarden will also be used to re-login into existing job boards if necessary at a nearly fully automated process. 
-	7/20 update: the parsing and resume gen v1 is doing good work, somethings I’ll like to mention is anti-ai/robot practices (ie security codes, “are you human?”) and industry preferences (ie I have experience in healthcare/tech, but would like to expand to other industries)
Technologies requirements necessary? Right now, we want to focus on Windows 11 and Google Chrome, 4GB RAM, as well as a constant stream of internet connection (25-100 Mbps), as well as the usage of other apps, such as:
-	Electron — wraps your web app as a Windows desktop app
-	Playwright — browser automation, open source, reliable
-	React — frontend dashboard UI
-	SQLite — local database for user data and application logs
-	Claude API — resume tailoring and cover letter generation
-	Chrome Extension — file injection into job portals
What does it NOT do? It does not auto-apply to hundreds of job applications per day. It does not auto-message hiring managers/relevant employees on LinkedIn or Email. It does not auto-create an entire resume/certain document(s) from scratch, a resume (or resume template) is needed for this product to be used. It is not a job application tracking tool, although there might be some elements that is like one. It is not a professional, job service/advisor-esc application. 
Potential risks? The top risks would be: 
-	TOS violations from certain company job boards/career portals 
-	AI answers/responses not being the most accurate according to user’s standards when answering unique job-related questions
-	Company website/career portals parsing failures/inconsistencies, requires trial-and-error and research
Other risks can also be: costs scaling if the app blows up (a positive problem to have, will figure this out if this ever happens), ad partnerships dependency is huge as it is a core feature of our product: affordability and sustainability (will need to provide reason on WHY ads want to be shown), general data privacy concerns, other competitors creating a similar feature (will want to leverage hyper user-friendly dashboard, ads, and “being the cheapest option” aspect), and user trust (will need to nearly perfect the AI responses and the auto-apply process, will not take this to public market until I am satisfied with the process)   
How is this being priced? There are 3 versions/tiers of this system: standard (free), plus ($15), and premium ($20). Standard provides 5 auto job applies per day, plus will provide 10 and premium will provide 15. However, each version can allow more auto job applies for the day if the user watches ads (short term and long term ads). Ad/Marketing companies can use our platform to help push their products and services. Example, for the standard version, short term ads can provide 2-3 auto applies and long-term ads can provide 5 auto applies, it is up to the user to decide. The amount of auto applies earned via ads are limited to each version, the standard version can obtain up to 5 additional auto applies, for the plus version an additional 15, and for premium, an additional 20. Depending on the version each ad watched can provide an additional amount of auto applies, ie short term ads for the standard version can provide 2-3 auto applies while for the premium version, it can provide 6-10 auto applies and vice versa. Each tier will also provide other unique benefits/differences, such as additional links a user can provide (standard is 10 links, plus is 15, and premium is 20)
UPDATE ON PRICING: will need to re-adjust, costs might end up being too much without a dedicated ad-channel to properly support free users if the scale is too much…
Why us instead of them? One glaring issue we see is either how expensive, how anti-user friendly, and/or how ineffective other competitors are with their version of auto-applies. At Seekr, we seek to provide working, updated, unique resume(s)/cover letter(s) to specific job boards. By focusing on only a handful of auto applies instead of hundreds per day, we can focus on quality control and assurance better then others. Another feature is the pricing of our system. We do not want to force users into using a paid model of our system, nor do we want to lock out our core features to those who are uncomfortable with paying. So through our ad model system, we are able to better sustain and maintain our operations and allows the users to comfortably use our system more often than others. 
Core process/user flow:
1.	A user signs up and provides a completed resume (and maybe cover letter, optional). 
a.	System will scan and ask the user what parts of the resume will need to be altered per application.
2.	User answers a series of unique questions about them and sets the filter for what type of job, job details, roles, titles, companies, experience, etc
3.	The system will ask the user to download/have access to a series of other applications/software to use this system effectively 
4.	Once completed, the system will guide the user to a test run of the auto apply feature 
a.	First, the user will provide 1 working link, Seekr will check and see if this link is applicable
b.	On the dashboard, Seekr will provide their recommendations for the auto apply.
i.	The user can check and see if these recommendations are suitable or not, they could also provide Seekr additional job roles/titles from the same link if Seekr did not recommend it 
c.	From finding the job, creating the resume and turning it into a PDF, placing the resume into the job portal, answering all necessary questions with the relevant info the user provided beforehand, answering all unique questions with AI responses (knowing the user’s background and preferences), and will stop right before applying, to allow the user to then accept. 
i.	The last part will be automated, this just a show of what the system is capable of.
ii.	All of this will be shown on the dashboard, akin to a VM-like demonstration, displaying Seekr’s ability to auto-apply. 
5.	The user can either accept this, or fine tune this further. 
a.	To fine tune it, the user can guide Seekr through each step on certain parts of the application that needs fine tuning. The user can also re-adjust their preferences if necessary. 
b.	Once fine tuning process is done, then Seekr will proceed to demonstrate again the process repeats until the user is satisfied. 
6.	Once completed, the user can begin letting the system “run”
7.	If the system runs successfully after the maximum amount of daily auto applies with no issues, then it is a success.
a.	Will provide notifications for each run on what jobs they applied.
b.	And will log and document each successful auto-apply, as well as flag any potential issues, such as an auto-applying for a job but could not complete it. 
8.	Additional jobs that were not auto-applied will be shown on the dashboard like a job board. But this will only pertain to the links provided by the user.
a.	The user can manually apply to these roles
b.	These other roles can also act as a “queue” system for the next day it will run, provided the company/career website doesn’t add in new, relevant roles. 
9.	On top of that, the system prompts and asks the user if they would like to add more auto-applies when watching the ad(s). 
10.	If they agree, once done watching, then allow system to run once more.
11.	If system runs without issues, success!
Competitors:
1.	Wobo.ai: yeah, I think I might be fucked. This does exactly what I need to do but better funded, better developed, and is a proven service/app…
a.	Update on Wobo.ai: it’s ass, at least the free version it is, not going to spend $45 just to try out its “full” capabilities. FULL SPEED AHEAD, STILL HAVE AN OPPORTUNITY TO CREATE SOMETHING HUGE!
2.	FastApply: Not Free, 5 free auto applies into $15/month, most basic plan provides 200 jobs a month
3.	LazyApply/Sonora: Not free, not even a free trial, most basic plan is $24/month, despite of auto applying terminology, nothing actually indicates auto applying
4.	LoopCV: Have used this, this DOES NOT AUTO APPLY, this auto aggregates jobs from online into 1 job board. 
5.	JobCopilot: Not free, $30 per month, 20 jobs daily

Mission Statement:
"Job searching shouldn't require you to sit down for hours pumping out applications. For people who are busy, burned out, or just not feeling it — there's no reliable, affordable, and actually effective way to automate the process. Seekr fixes that."

