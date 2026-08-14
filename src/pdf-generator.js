// pdf-generator.js - Generate ATS-friendly PDF documents from HTML templates
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { config } from './config.js';
import { log } from './utils.js';

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browser;
}

/**
 * Render HTML string to PDF and save to file
 */
async function htmlToPdf(html, outputPath) {
  const b = await getBrowser();
  const page = await b.newPage();

  await page.setContent(html, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: outputPath,
    format: 'A4',
    margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' },
    printBackground: false,
  });

  await page.close();
}

/**
 * Build resume HTML from structured data
 */
function buildResumeHtml(resumeData) {
  const p = resumeData.personal || {};
  const contactParts = [p.email, p.phone, p.location, p.linkedin, p.github, p.portfolio].filter(Boolean);

  const experienceHtml = (resumeData.experience || []).map(exp => `
    <div class="entry">
      <div class="entry-header">
        <div class="entry-title">${exp.title}</div>
        <div class="entry-date">${exp.dates}</div>
      </div>
      <div class="entry-subtitle">${exp.company}${exp.location ? ` — ${exp.location}` : ''}</div>
      <ul>${(exp.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul>
    </div>
  `).join('');

  const educationHtml = (resumeData.education || []).map(edu => `
    <div class="entry">
      <div class="entry-header">
        <div class="entry-title">${edu.degree}</div>
        <div class="entry-date">${edu.date}</div>
      </div>
      <div class="entry-subtitle">${edu.institution}</div>
      ${edu.details ? `<p class="entry-details">${edu.details}</p>` : ''}
    </div>
  `).join('');

  const primarySkills = (resumeData.skills?.primary || []).join(' • ');
  const secondarySkills = (resumeData.skills?.secondary || []).join(' • ');

  const certsHtml = (resumeData.certifications || [])
    .filter(c => c.name)
    .map(c => `<li>${c.name} — ${c.issuer} (${c.date})</li>`)
    .join('');

  const projectsHtml = (resumeData.projects || [])
    .filter(proj => proj.name)
    .map(proj => `
      <div class="entry">
        <div class="entry-title">${proj.name}</div>
        <p>${proj.description}</p>
        ${proj.technologies?.length ? `<p class="tech-stack">Technologies: ${proj.technologies.join(', ')}</p>` : ''}
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Calibri', 'Arial', 'Helvetica Neue', sans-serif;
      font-size: 11pt;
      line-height: 1.4;
      color: #1a1a1a;
    }
    .header {
      text-align: center;
      margin-bottom: 12px;
      border-bottom: 2px solid #2c3e50;
      padding-bottom: 8px;
    }
    .name {
      font-size: 22pt;
      font-weight: bold;
      color: #2c3e50;
      margin-bottom: 4px;
    }
    .contact {
      font-size: 9.5pt;
      color: #555;
    }
    .contact span { margin: 0 6px; }
    .section {
      margin-bottom: 10px;
    }
    .section-title {
      font-size: 12pt;
      font-weight: bold;
      color: #2c3e50;
      border-bottom: 1px solid #bdc3c7;
      margin-bottom: 6px;
      padding-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .entry { margin-bottom: 8px; }
    .entry-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .entry-title { font-weight: bold; font-size: 11pt; }
    .entry-date { font-size: 10pt; color: #555; white-space: nowrap; }
    .entry-subtitle { font-style: italic; color: #444; font-size: 10.5pt; margin-bottom: 3px; }
    .entry-details { font-size: 10pt; color: #555; margin-top: 2px; }
    ul { padding-left: 18px; margin-top: 3px; }
    li { margin-bottom: 2px; font-size: 10.5pt; }
    .skills-list { font-size: 10.5pt; line-height: 1.5; }
    .skills-label { font-weight: bold; }
    .tech-stack { font-size: 9.5pt; color: #555; font-style: italic; }
    .summary { font-size: 10.5pt; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="header">
    <div class="name">${p.name || 'Your Name'}</div>
    <div class="contact">${contactParts.map(c => `<span>${c}</span>`).join(' | ')}</div>
  </div>

  <div class="section">
    <div class="section-title">Professional Summary</div>
    <p class="summary">${resumeData.professional_summary || ''}</p>
  </div>

  ${experienceHtml ? `
  <div class="section">
    <div class="section-title">Experience</div>
    ${experienceHtml}
  </div>` : ''}

  <div class="section">
    <div class="section-title">Skills</div>
    <div class="skills-list">
      ${primarySkills ? `<p><span class="skills-label">Core: </span>${primarySkills}</p>` : ''}
      ${secondarySkills ? `<p><span class="skills-label">Additional: </span>${secondarySkills}</p>` : ''}
    </div>
  </div>

  ${educationHtml ? `
  <div class="section">
    <div class="section-title">Education</div>
    ${educationHtml}
  </div>` : ''}

  ${certsHtml ? `
  <div class="section">
    <div class="section-title">Certifications</div>
    <ul>${certsHtml}</ul>
  </div>` : ''}

  ${projectsHtml ? `
  <div class="section">
    <div class="section-title">Projects</div>
    ${projectsHtml}
  </div>` : ''}
</body>
</html>`;
}

/**
 * Build cover letter HTML from structured data
 */
function buildCoverLetterHtml(coverLetterData) {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Calibri', 'Arial', 'Helvetica Neue', sans-serif;
      font-size: 11.5pt;
      line-height: 1.6;
      color: #1a1a1a;
    }
    .letter {
      max-width: 100%;
    }
    .date {
      margin-bottom: 20px;
      color: #555;
    }
    .greeting {
      margin-bottom: 14px;
      font-weight: bold;
    }
    .paragraph {
      margin-bottom: 14px;
      text-align: justify;
    }
    .sign-off {
      margin-top: 24px;
    }
    .sign-off-text {
      margin-bottom: 24px;
    }
    .applicant-name {
      font-weight: bold;
      font-size: 12pt;
    }
    .applicant-contact {
      font-size: 10pt;
      color: #555;
      margin-top: 2px;
    }
  </style>
</head>
<body>
  <div class="letter">
    <div class="date">${today}</div>

    <div class="paragraph">
      <strong>Re: Application for ${coverLetterData.job_title} at ${coverLetterData.company}</strong>
    </div>

    <div class="greeting">${coverLetterData.greeting || 'Dear Hiring Manager,'}</div>

    <div class="paragraph">${coverLetterData.opening || ''}</div>
    <div class="paragraph">${coverLetterData.body_1 || ''}</div>
    <div class="paragraph">${coverLetterData.body_2 || ''}</div>
    <div class="paragraph">${coverLetterData.closing || ''}</div>

    <div class="sign-off">
      <div class="sign-off-text">${coverLetterData.sign_off || 'Sincerely,'}</div>
      <div class="applicant-name">${coverLetterData.applicant_name || ''}</div>
      <div class="applicant-contact">
        ${coverLetterData.applicant_email || ''}${coverLetterData.applicant_phone ? ` | ${coverLetterData.applicant_phone}` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate resume PDF for a specific job
 */
export async function generateResumePdf(resumeData, outputPath) {
  const html = buildResumeHtml(resumeData);
  await htmlToPdf(html, outputPath);
  log('info', `Resume PDF saved: ${outputPath}`);
}

/**
 * Generate cover letter PDF for a specific job
 */
export async function generateCoverLetterPdf(coverLetterData, outputPath) {
  const html = buildCoverLetterHtml(coverLetterData);
  await htmlToPdf(html, outputPath);
  log('info', `Cover letter PDF saved: ${outputPath}`);
}

/**
 * Close the browser instance
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
