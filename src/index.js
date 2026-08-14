#!/usr/bin/env node
// index.js - Main CLI orchestrator for Job Finder v2.0
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createObjectCsvWriter } from 'csv-writer';
import { config, validateConfig } from './config.js';
import { log } from './utils.js';
import { setupProfile, loadProfile, profileExists } from './profile-manager.js';
import { aggregateJobs } from './job-aggregator.js';
import { matchJobs } from './ai-matcher.js';
import { generateResume } from './resume-generator.js';
import { generateCoverLetter } from './cover-letter-generator.js';
import { generateResumePdf, generateCoverLetterPdf, closeBrowser } from './pdf-generator.js';
import { sendApplications } from './email-sender.js';

// CLI definition
const argv = yargs(hideBin(process.argv))
  .command('setup', 'Parse your resume and create a profile', (yargs) => {
    yargs.option('resume', {
      alias: 'r',
      type: 'string',
      description: 'Path to resume PDF file',
      default: 'resume.pdf',
    });
  })
  .command('search', 'Search for matching jobs and generate applications', (yargs) => {
    yargs
      .option('generate-docs', {
        alias: 'g',
        type: 'boolean',
        description: 'Generate tailored resume and cover letter for each match',
        default: false,
      })
      .option('send-emails', {
        alias: 'e',
        type: 'boolean',
        description: 'Send application emails (requires SMTP config)',
        default: false,
      })
      .option('min-score', {
        alias: 's',
        type: 'number',
        description: 'Minimum match score (0-100)',
        default: config.search.minMatchScore,
      })
      .option('max-age', {
        type: 'number',
        description: 'Maximum job age in hours',
        default: config.search.maxAgeHours,
      })
      .option('dry-run', {
        type: 'boolean',
        description: 'Show what would be done without sending emails',
        default: false,
      })
      .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output directory',
        default: config.outputDir,
      });
  })
  .command('profile', 'Display your current profile')
  .demandCommand(1, 'Please specify a command: setup, search, or profile')
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Enable verbose logging',
    default: false,
  })
  .help()
  .version('2.0.0')
  .argv;

// ─── Setup Command ──────────────────────────────────────────────
async function runSetup(args) {
  const resumePath = path.resolve(args.resume);

  if (!fs.existsSync(resumePath)) {
    log('error', `Resume file not found: ${resumePath}`);
    process.exit(1);
  }

  const validation = validateConfig();
  if (!validation.valid) {
    log('error', `Configuration errors:\n  ${validation.errors.join('\n  ')}`);
    process.exit(1);
  }

  log('info', '=== PROFILE SETUP ===');
  const profile = await setupProfile(resumePath);
  log('info', '\nProfile created successfully! You can review/edit it at: data/profile.json');
  log('info', 'Next step: Run "node src/index.js search" to find matching jobs.');
}

// ─── Profile Command ────────────────────────────────────────────
function runProfile() {
  if (!profileExists()) {
    log('error', 'No profile found. Run "node src/index.js setup --resume resume.pdf" first.');
    process.exit(1);
  }

  const profile = loadProfile();
  log('info', '=== YOUR PROFILE ===');
  log('info', `Name: ${profile.personal?.name || 'N/A'}`);
  log('info', `Email: ${profile.personal?.email || 'N/A'}`);
  log('info', `Location: ${profile.personal?.location || 'N/A'}`);
  log('info', `Years of Experience: ${profile.years_of_experience || 'N/A'}`);
  log('info', `\nSummary: ${profile.summary || 'N/A'}`);

  log('info', '\nExperience:');
  (profile.experience || []).forEach(e => {
    log('info', `  - ${e.title} at ${e.company} (${e.start_date} - ${e.end_date})`);
  });

  const allSkills = Object.values(profile.skills || {}).flat().filter(Boolean);
  log('info', `\nSkills (${allSkills.length}): ${allSkills.join(', ')}`);

  log('info', '\nEducation:');
  (profile.education || []).forEach(e => {
    log('info', `  - ${e.degree} from ${e.institution} (${e.graduation_date})`);
  });

  log('info', `\nProfile file: data/profile.json (edit directly to update)`);
}

// ─── Search Command ─────────────────────────────────────────────
async function runSearch(args) {
  const validation = validateConfig();
  if (!validation.valid) {
    log('error', `Configuration errors:\n  ${validation.errors.join('\n  ')}`);
    process.exit(1);
  }

  if (!profileExists()) {
    log('error', 'No profile found. Run "node src/index.js setup --resume resume.pdf" first.');
    process.exit(1);
  }

  const profile = loadProfile();
  log('info', '=== JOB SEARCH ===');
  log('info', `Profile: ${profile.personal?.name || 'Unknown'}`);
  log('info', `Min match score: ${args.minScore}%`);
  log('info', `Max job age: ${args.maxAge} hours`);
  log('info', `Generate docs: ${args.generateDocs ? 'Yes' : 'No'}`);
  log('info', `Send emails: ${args.sendEmails ? 'Yes' : 'No'}`);
  log('info', '');

  // Step 1: Aggregate jobs from all sources
  log('info', 'Step 1/5: Fetching jobs from all sources...');
  const { jobs, stats } = await aggregateJobs({ maxAgeHours: args.maxAge });

  if (jobs.length === 0) {
    log('warn', 'No jobs found matching criteria. Try increasing --max-age or check API keys.');
    return;
  }

  log('info', `Found ${jobs.length} eligible jobs from ${Object.keys(stats.sources).length} sources\n`);

  // Step 2: AI matching
  log('info', 'Step 2/5: AI-powered job matching...');
  const matchedJobs = await matchJobs(profile, jobs, { minScore: args.minScore });

  if (matchedJobs.length === 0) {
    log('warn', `No jobs scored above ${args.minScore}%. Consider lowering --min-score.`);
    log('info', 'Tip: Current threshold is very selective. Try --min-score 85 for more results.');
    return;
  }

  log('info', `\n${matchedJobs.length} jobs scored ${args.minScore}%+\n`);

  // Ensure output directory exists
  const outputDir = path.resolve(args.output || config.outputDir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 3: Generate tailored documents
  if (args.generateDocs) {
    log('info', 'Step 3/5: Generating tailored resumes and cover letters...');

    for (let i = 0; i < matchedJobs.length; i++) {
      const job = matchedJobs[i];
      const slug = `${job.company}-${job.title}`.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().substring(0, 60);
      const jobDir = path.join(outputDir, slug);

      if (!fs.existsSync(jobDir)) {
        fs.mkdirSync(jobDir, { recursive: true });
      }

      log('info', `  [${i + 1}/${matchedJobs.length}] ${job.title} at ${job.company}...`);

      try {
        // Generate tailored resume
        const resumeData = await generateResume(profile, job);
        await generateResumePdf(resumeData, path.join(jobDir, 'resume.pdf'));

        // Save resume JSON for reference
        fs.writeFileSync(path.join(jobDir, 'resume.json'), JSON.stringify(resumeData, null, 2));

        // Generate cover letter
        const coverLetterData = await generateCoverLetter(profile, job);
        await generateCoverLetterPdf(coverLetterData, path.join(jobDir, 'cover-letter.pdf'));

        // Save cover letter JSON for reference
        fs.writeFileSync(path.join(jobDir, 'cover-letter.json'), JSON.stringify(coverLetterData, null, 2));

        // Save job details
        fs.writeFileSync(path.join(jobDir, 'job-details.json'), JSON.stringify(job, null, 2));

        log('info', `    Documents saved to: ${jobDir}`);
      } catch (error) {
        log('error', `    Failed to generate docs for ${job.title}: ${error.message}`);
      }
    }
  } else {
    log('info', 'Step 3/5: Skipped (use --generate-docs to create tailored documents)');
  }

  // Step 4: Send emails
  if (args.sendEmails) {
    log('info', 'Step 4/5: Sending application emails...');
    const emailResult = await sendApplications(matchedJobs, { dryRun: args.dryRun });
    log('info', `Email results: ${JSON.stringify(emailResult)}`);
  } else {
    log('info', 'Step 4/5: Skipped (use --send-emails to send applications)');
  }

  // Step 5: Save results
  log('info', 'Step 5/5: Saving results...');
  await saveResults(matchedJobs, outputDir, stats);

  // Print summary
  printSummary(matchedJobs, stats);
}

// ─── Save Results ───────────────────────────────────────────────
async function saveResults(jobs, outputDir, stats) {
  // Save JSON
  const jsonPath = path.join(outputDir, 'results.json');
  const jsonData = {
    metadata: {
      total_jobs: jobs.length,
      generated_at: new Date().toISOString(),
      version: '2.0.0',
      sources: stats.sources,
    },
    jobs: jobs.map(job => ({
      title: job.title,
      company: job.company,
      location: job.location,
      match_score: job.match_score,
      match_reasoning: job.match_reasoning,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      currency: job.currency,
      url: job.url,
      apply_url: job.apply_url,
      posted_date: job.posted_date,
      source: job.source,
      remote: job.remote,
      sponsorship_mentioned: job.sponsorship_mentioned,
      country: job.country,
    })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  log('info', `Results JSON saved: ${jsonPath}`);

  // Save CSV
  const csvPath = path.join(outputDir, 'results.csv');
  const csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: [
      { id: 'title', title: 'Job Title' },
      { id: 'company', title: 'Company' },
      { id: 'location', title: 'Location' },
      { id: 'match_score', title: 'Match Score (%)' },
      { id: 'match_reasoning', title: 'Match Reasoning' },
      { id: 'salary_min', title: 'Salary Min' },
      { id: 'salary_max', title: 'Salary Max' },
      { id: 'currency', title: 'Currency' },
      { id: 'url', title: 'Job URL' },
      { id: 'apply_url', title: 'Apply URL' },
      { id: 'posted_date', title: 'Posted Date' },
      { id: 'source', title: 'Source' },
      { id: 'remote', title: 'Remote' },
      { id: 'sponsorship_mentioned', title: 'Sponsorship' },
      { id: 'country', title: 'Country' },
    ],
  });

  await csvWriter.writeRecords(jobs);
  log('info', `Results CSV saved: ${csvPath}`);
}

// ─── Summary ────────────────────────────────────────────────────
function printSummary(jobs, stats) {
  log('info', '\n══════════════════════════════════════════');
  log('info', '           JOB SEARCH SUMMARY');
  log('info', '══════════════════════════════════════════');
  log('info', `Total matching jobs: ${jobs.length}`);
  log('info', '');

  // Source breakdown
  log('info', 'Sources:');
  Object.entries(stats.sources).forEach(([source, count]) => {
    log('info', `  ${source}: ${count} jobs`);
  });

  if (jobs.length === 0) return;

  // Top matches
  log('info', '\nTop Matches:');
  jobs.slice(0, 10).forEach((job, i) => {
    const salary = job.salary_min ? ` | ${job.currency || 'USD'} ${job.salary_min.toLocaleString()}${job.salary_max ? `-${job.salary_max.toLocaleString()}` : ''}` : '';
    log('info', `  ${i + 1}. [${job.match_score}%] ${job.title} at ${job.company} (${job.location})${salary}`);
    log('info', `     ${job.match_reasoning || ''}`);
    log('info', `     Apply: ${job.apply_url || job.url}`);
  });

  // Stats
  const remoteCount = jobs.filter(j => j.remote).length;
  const sponsorCount = jobs.filter(j => j.sponsorship_mentioned).length;
  const withSalary = jobs.filter(j => j.salary_min);

  log('info', '\nBreakdown:');
  log('info', `  Remote positions: ${remoteCount}`);
  log('info', `  Mention sponsorship: ${sponsorCount}`);
  log('info', `  With salary info: ${withSalary.length}`);

  if (withSalary.length > 0) {
    const salaries = withSalary.map(j => j.salary_min);
    const avg = Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length);
    log('info', `  Avg salary (min): ${avg.toLocaleString()}`);
  }

  // Country distribution
  const countryCounts = {};
  jobs.forEach(j => {
    const c = j.country || 'Unknown';
    countryCounts[c] = (countryCounts[c] || 0) + 1;
  });

  log('info', '\nCountries:');
  Object.entries(countryCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .forEach(([country, count]) => {
      log('info', `  ${country}: ${count}`);
    });

  log('info', '\n══════════════════════════════════════════');
  log('info', `Results saved to: ${config.outputDir}/`);
  log('info', '══════════════════════════════════════════\n');
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  try {
    const command = argv._[0];

    switch (command) {
      case 'setup':
        await runSetup(argv);
        break;
      case 'search':
        await runSearch(argv);
        break;
      case 'profile':
        runProfile();
        break;
      default:
        log('error', `Unknown command: ${command}. Use setup, search, or profile.`);
        process.exit(1);
    }
  } catch (error) {
    log('error', `Fatal error: ${error.message}`);
    if (argv.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

main();
