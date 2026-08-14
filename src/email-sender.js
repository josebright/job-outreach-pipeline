// email-sender.js - Send application emails with resume and cover letter attachments
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log, sleep } from './utils.js';

const EMAIL_LOG_PATH = path.join(config.outputDir, 'email-log.json');

/**
 * Create SMTP transporter
 */
function createTransporter() {
  if (!config.smtp.user || !config.smtp.pass) {
    throw new Error('SMTP credentials not configured. Set SMTP_USER and SMTP_PASS in .env');
  }

  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

/**
 * Load email log
 */
function loadEmailLog() {
  try {
    if (fs.existsSync(EMAIL_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(EMAIL_LOG_PATH, 'utf8'));
    }
  } catch (error) {
    log('warn', `Could not load email log: ${error.message}`);
  }
  return { sent: [], failed: [] };
}

/**
 * Save email log
 */
function saveEmailLog(emailLog) {
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  fs.writeFileSync(EMAIL_LOG_PATH, JSON.stringify(emailLog, null, 2));
}

/**
 * Check if email was already sent for a job
 */
function alreadySent(emailLog, jobId) {
  return emailLog.sent.some(entry => entry.job_id === jobId);
}

/**
 * Send application email for a single job
 */
async function sendApplicationEmail(transporter, job, resumePath, coverLetterPath) {
  const senderName = config.userName || 'Job Applicant';
  const senderEmail = config.userEmail || config.smtp.user;

  const subject = `Application for ${job.title} - ${senderName}`;

  const body = `Dear Hiring Team,

I am writing to express my interest in the ${job.title} position at ${job.company}.

Please find attached my resume and cover letter for your review. I am excited about this opportunity and believe my experience and skills make me a strong candidate for this role.

I look forward to the opportunity to discuss how I can contribute to ${job.company}.

Thank you for your time and consideration.

Best regards,
${senderName}
${senderEmail}`;

  const attachments = [];
  if (resumePath && fs.existsSync(resumePath)) {
    attachments.push({
      filename: `${senderName.replace(/\s+/g, '_')}_Resume.pdf`,
      path: resumePath,
    });
  }
  if (coverLetterPath && fs.existsSync(coverLetterPath)) {
    attachments.push({
      filename: `${senderName.replace(/\s+/g, '_')}_Cover_Letter.pdf`,
      path: coverLetterPath,
    });
  }

  const mailOptions = {
    from: `"${senderName}" <${senderEmail}>`,
    to: job.apply_email || job.contact_email,
    subject: subject,
    text: body,
    attachments: attachments,
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

/**
 * Send application emails for multiple jobs
 * Only sends to jobs that have an email contact
 */
export async function sendApplications(jobs, options = {}) {
  const { dryRun = false } = options;
  const emailLog = loadEmailLog();

  // Filter to jobs with email contacts that haven't been sent yet
  const jobsToEmail = jobs.filter(job => {
    if (!job.apply_email && !job.contact_email) return false;
    if (alreadySent(emailLog, job.id)) {
      log('info', `Skipping ${job.title} at ${job.company} — already sent`);
      return false;
    }
    return true;
  });

  if (jobsToEmail.length === 0) {
    log('info', 'No jobs with email contacts to send applications to');
    return { sent: 0, failed: 0, skipped: jobs.length - jobsToEmail.length };
  }

  log('info', `Preparing to send ${jobsToEmail.length} application emails${dryRun ? ' (DRY RUN)' : ''}...`);

  if (dryRun) {
    jobsToEmail.forEach(job => {
      log('info', `[DRY RUN] Would send to: ${job.apply_email || job.contact_email} for ${job.title} at ${job.company}`);
    });
    return { sent: 0, failed: 0, skipped: 0, dry_run: true };
  }

  let transporter;
  try {
    transporter = createTransporter();
    await transporter.verify();
    log('info', 'SMTP connection verified');
  } catch (error) {
    log('error', `SMTP connection failed: ${error.message}`);
    return { sent: 0, failed: jobsToEmail.length, error: error.message };
  }

  let sent = 0;
  let failed = 0;
  const delayBetweenEmails = (60 * 60 * 1000) / config.rateLimits.emailsPerHour; // ms between emails

  for (const job of jobsToEmail) {
    try {
      // Build paths to generated documents
      const slug = `${job.company}-${job.title}`.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().substring(0, 60);
      const jobDir = path.join(config.outputDir, slug);
      const resumePath = path.join(jobDir, 'resume.pdf');
      const coverLetterPath = path.join(jobDir, 'cover-letter.pdf');

      const info = await sendApplicationEmail(transporter, job, resumePath, coverLetterPath);

      emailLog.sent.push({
        job_id: job.id,
        job_title: job.title,
        company: job.company,
        to: job.apply_email || job.contact_email,
        message_id: info.messageId,
        sent_at: new Date().toISOString(),
      });

      sent++;
      log('info', `Sent application to ${job.company} for ${job.title}`);

      // Rate limit
      if (sent < jobsToEmail.length) {
        await sleep(delayBetweenEmails);
      }
    } catch (error) {
      emailLog.failed.push({
        job_id: job.id,
        job_title: job.title,
        company: job.company,
        error: error.message,
        failed_at: new Date().toISOString(),
      });

      failed++;
      log('error', `Failed to send email for ${job.title} at ${job.company}: ${error.message}`);
    }
  }

  saveEmailLog(emailLog);
  log('info', `Email sending complete: ${sent} sent, ${failed} failed`);

  return { sent, failed, skipped: jobs.length - jobsToEmail.length };
}
