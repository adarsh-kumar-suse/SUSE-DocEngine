import fs from 'fs';

const jobs = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));
const latestJob = jobs[jobs.length - 1];
console.log(JSON.stringify(latestJob, null, 2));
