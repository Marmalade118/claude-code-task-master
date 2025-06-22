<context>
# Overview
The ReactionGears Marketing Engine is an internal marketing automation tool to systematically find companies with poor websites, allow manual review and selection, then analyze their specific issues and send personalized outreach emails that demonstrate how we can improve their web presence. This is a completely internal system - customers will only see the emails we send them, which will link to our existing website at www.ReactionGears.com. The system automates lead discovery and email outreach, while website analysis is triggered manually after human review.

# Core Features
1. **Zipcode-Based Lead Discovery**
   - What it does: Finds all small, locally-owned businesses in a specific zipcode
   - Why it's important: Targets hyperlocal market for personalized outreach
   - How it works: Enter zipcode → Query business directories → Collect business name, owner name, phone, email, website → Automatically scan all websites
   - Implementation: Netlify Functions for API security
   ```javascript
   // netlify/functions/discover-leads.js
   exports.handler = async (event) => {
     const { zipcode } = event.queryStringParameters
     
     // Parallel API calls with server-side keys
     const [googleData, yelpData] = await Promise.all([
       fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?
         location=${zipcode}&type=business&key=${process.env.GOOGLE_PLACES_API_KEY}`),
       fetch(`https://api.yelp.com/v3/businesses/search?
         location=${zipcode}`, {
         headers: { 'Authorization': `Bearer ${process.env.YELP_API_KEY}` }
       })
     ])
     
     // Merge and deduplicate results
     const leads = mergeBusinessData(googleData, yelpData)
     
     // Store in Supabase
     await supabase.from('leads').insert(leads)
     
     return { statusCode: 200, body: JSON.stringify({ leads }) }
   }
   ```

2. **Automatic Website Analysis with Level 1 Security Scanning**
   - What it does: Automatically scans ALL collected websites for technology stack, UX/design issues, AND security vulnerabilities (passive/legal only)
   - Why it's important: Pre-qualifies leads by identifying outdated technologies, conversion-killing design flaws, and security risks
   - How it works: 
     - WappalyzerGo detects CMS, frameworks, libraries, server tech
     - Lighthouse analyzes performance, accessibility, SEO scores
     - Pa11y/axe-core checks WCAG compliance and contrast ratios
     - Custom tools analyze whitespace, CTA placement, form complexity
     - Level 1 Security Scan (legal without authorization):
       - SSL/TLS configuration analysis
       - Security headers check (X-Frame-Options, CSP, etc.)
       - HTTPS redirect verification
       - Outdated software with known vulnerabilities
       - Public blacklist/reputation checking
       - Email security (SPF, DKIM, DMARC)
     - Generates evidence-based improvement recommendations with projected gains

3. **AI-Powered Email Generation**
   - What it does: Uses AI to generate personalized HTML emails with customizable tone and style, highlighting top 3-5 improvement areas
   - Why it's important: AI-crafted pitches using real data create compelling, unique messages that convert better than templates
   - How it works: 
     - Feed all report data to AI (tech stack, UX scores, specific issues)
     - Configure tone (professional, friendly, urgent) and style preferences
     - AI writes personalized pitch focusing on biggest impact improvements
     - Generates beautiful HTML email with report highlights
     - Includes Calendly link CTA for free consultation
     - Manual review and edit before sending
   - Implementation: Netlify Function with Claude Code SDK
   ```javascript
   // netlify/functions/generate-email.js
   import { ClaudeCodeSDK } from '@anthropic-ai/claude-code-sdk'
   
   exports.handler = async (event) => {
     const { leadData, analysisResults, config } = JSON.parse(event.body)
     
     const claude = new ClaudeCodeSDK({
       apiKey: process.env.CLAUDE_API_KEY // Your Max account
     })
     
     const prompt = `Generate a personalized email for ${leadData.owner_name} at ${leadData.business_name}.
     
     Their website ${leadData.website_url} has these issues:
     - Security: ${analysisResults.security.score}/100 
     - Performance: Loads in ${analysisResults.performance.loadTime}s
     - Top UX Issues: ${analysisResults.ux.topIssues.join(', ')}
     
     Top 3 improvements with impact:
     ${analysisResults.recommendations.map((r, i) => 
       `${i+1}. ${r.issue} → ${r.impact}`
     ).join('\n')}
     
     Tone: ${config.tone}
     Length: ${config.length}
     Include Calendly CTA: ${process.env.CALENDLY_LINK}`
     
     const response = await claude.generate(prompt)
     
     return {
       statusCode: 200,
       body: JSON.stringify({
         subject: response.subject,
         html: response.html,
         preview: response.preview
       })
     }
   }
   ```

4. **Email Campaign Management**
   - What it does: After manual first email, tracks engagement and manages automated follow-ups
   - Why it's important: Persistent follow-up increases response rates by 160% while respecting manual control
   - How it works: 
     - Manual trigger for first email send
     - Tracks opens, clicks, replies
     - Automated follow-up sequences (if no response in X days)
     - Stop sequence on reply or booking
     - Engagement scoring for prioritization
   - Implementation: Split between Netlify Functions and Supabase
   
   **Email Sending (Netlify Function)**:
   ```javascript
   // netlify/functions/send-email.js
   import AWS from 'aws-sdk'
   
   const ses = new AWS.SES({
     accessKeyId: process.env.AWS_ACCESS_KEY,
     secretAccessKey: process.env.AWS_SECRET_KEY,
     region: 'us-east-1'
   })
   
   exports.handler = async (event) => {
     const { leadId, emailContent, campaignId } = JSON.parse(event.body)
     
     // Send via Amazon SES
     const result = await ses.sendEmail({
       Source: 'you@reactiongears.com',
       Destination: { ToAddresses: [lead.email] },
       Message: {
         Subject: { Data: emailContent.subject },
         Body: { 
           Html: { 
             Data: addTrackingPixel(emailContent.html, leadId) 
           }
         }
       }
     }).promise()
     
     // Log to Supabase
     await supabase.from('email_events').insert({
       lead_id: leadId,
       campaign_id: campaignId,
       message_id: result.MessageId,
       status: 'sent',
       sent_at: new Date()
     })
     
     return { statusCode: 200, body: JSON.stringify({ messageId: result.MessageId }) }
   }
   ```
   
   **Tracking (Netlify Function)**:
   ```javascript
   // netlify/functions/track-email.js
   exports.handler = async (event) => {
     const { messageId, event: trackEvent, url } = event.queryStringParameters
     
     // Record in Supabase
     await supabase.from('email_events').insert({
       message_id: messageId,
       event_type: trackEvent, // 'open' or 'click'
       timestamp: new Date()
     })
     
     if (trackEvent === 'open') {
       // Return 1x1 tracking pixel
       return {
         statusCode: 200,
         headers: { 'Content-Type': 'image/gif' },
         body: TRACKING_PIXEL_BASE64,
         isBase64Encoded: true
       }
     }
     
     // Redirect clicks to actual URL
     return {
       statusCode: 302,
       headers: { Location: url }
     }
   }
   ```
   
   **Automated Follow-ups (Supabase)**:
   ```sql
   -- Supabase Database Function
   CREATE OR REPLACE FUNCTION schedule_follow_ups()
   RETURNS void AS $$
   BEGIN
     INSERT INTO email_queue (lead_id, template_id, scheduled_for)
     SELECT 
       e.lead_id,
       f.template_id,
       NOW() + INTERVAL '3 days'
     FROM email_events e
     JOIN follow_up_rules f ON f.days_after = 3
     WHERE e.event_type = 'sent'
       AND e.created_at > NOW() - INTERVAL '3 days'
       AND NOT EXISTS (
         SELECT 1 FROM email_events 
         WHERE lead_id = e.lead_id 
         AND event_type IN ('replied', 'booked', 'clicked')
       );
   END;
   $$ LANGUAGE plpgsql;
   
   -- Schedule to run hourly
   SELECT cron.schedule('follow-ups', '0 * * * *', 'SELECT schedule_follow_ups()');
   ```

5. **Internal Dashboard**
   - What it does: Shows campaign performance, hot leads, and system health
   - Why it's important: Helps optimize campaigns and focus on promising prospects
   - How it works: Real-time metrics, lead status tracking, campaign A/B test results, ROI calculations

6. **Level 2 Security Testing (Upsell Service)**
   - What it does: Comprehensive penetration testing with client authorization using open source tools
   - Why it's important: Additional revenue stream ($500-2000 per assessment) and deeper value proposition
   - How it works:
     - Requires signed authorization and legal documentation
     - Uses enterprise-grade open source tools:
       - OWASP ZAP for web application scanning
       - Nmap for port/service enumeration
       - SQLmap for SQL injection testing
       - XSStrike for XSS detection
       - OpenVAS for vulnerability assessment
       - Hydra for authentication testing
     - Delivers professional penetration test report with:
       - Executive summary
       - Technical findings with CVSS scores
       - Proof-of-concept demonstrations
       - Remediation roadmap
       - Compliance mapping (PCI DSS, HIPAA, etc.)

# User Experience
- **User Personas**:
  - Sales/Marketing team members who manage campaigns (primary)
  - Management reviewing performance metrics (secondary)
  
- **Key User Flows**:
  - Enter zipcode → System finds all small businesses → Automatically scans all websites → Review pre-analyzed leads → Select best prospects → Generate AI email → Review/edit → Manually send first email → Automated follow-ups begin
  - Check dashboard → Filter leads by tech issues → Select high-value target → Click "Generate Email" → AI creates pitch → Customize tone/message → Send
  - Review campaign metrics → See who opened/clicked → Adjust follow-up sequences → Track Calendly bookings
  
- **UI/UX Considerations**:
  - Simple internal interface (doesn't need to be pretty)
  - Bulk operations for efficiency
  - Clear status indicators for each prospect
  - Easy template editing
</context>
<PRD>
# Technical Architecture
**System Components**:
- Next.js admin panel with lead review interface (deployed on Netlify)
- Supabase for data storage and real-time updates
- Raspberry Pi 5 for ALL analysis and testing:
  - WappalyzerGo tech stack detection
  - Lighthouse performance analysis
  - Pa11y/axe-core accessibility testing
  - Custom UX analysis tools
  - Level 1 security scanning
  - Level 2 penetration testing
- No serverless functions needed - Pi handles all processing

**Data Models**:
- Prospects (business_name, owner_name, phone, email, website_url, zipcode, tech_stack, outdated_tech_flags, ux_score, scan_date, status)
- Website Audits (tech_stack_json, wappalyzer_categories, performance_scores, accessibility_score, ux_issues_json, conversion_blockers, annotated_screenshots, improvement_projections, scan_timestamp)
- UX Issues (issue_type, severity, wcag_level, contrast_ratio, projected_impact, fix_recommendation, supporting_study)
- Pentest Jobs (id, client_id, target_url, scope, status, created_at, started_at, completed_at, report_url, error)
- Email Configuration (tone settings, style preferences, Calendly link)
- Generated Emails (HTML content, AI prompt used, report data included, send timestamp)
- Email Templates (follow-up sequences, not first email)
- Campaigns (target criteria, template used, schedule, metrics)
- Email Events (sent, opened, clicked, replied, bounced)

**APIs and Integrations**:
- Business Directory APIs for lead collection:
  - Google Places API (nearby search by zipcode)
  - Yelp Fusion API (local business data)
  - Facebook Graph API (local business pages)
- Apollo.io for email discovery (free tier - 60 credits/month)
- Claude Code SDK for AI email generation:
  - Uses your existing Claude Max account
  - No additional API costs
  - High-quality email generation
- SendGrid/Amazon SES for email delivery
- Calendly API for booking link integration
- Supabase APIs:
  - Realtime subscriptions for job status
  - Row Level Security for multi-user support
  - Storage for reports and screenshots

**All Analysis Tools Run on Raspberry Pi**:
- WappalyzerGo - Tech stack detection
- Lighthouse - Performance, accessibility, SEO analysis
- Pa11y/axe-core - WCAG compliance testing
- Puppeteer/Playwright - Screenshot generation
- Custom Python tools - UX analysis (whitespace, layout, CTA)
- Security Analysis Tools:
  - SSLyze - SSL/TLS vulnerability scanner
  - secheaders - Security headers analysis
  - nvdlib - CVE lookup (free NIST API key)
  - checkdmarc - Email security validation
  - dnspython - DNS blacklist checking
  - Google Safe Browsing API

**Custom UX Analysis Tools**:
What We'll Build:
1. **Whitespace Analyzer**
   - Uses OpenCV to detect UI elements
   - Calculates spacing ratios
   - Flags cramped layouts affecting readability
   ```python
   import cv2
   import numpy as np
   
   def analyze_whitespace(screenshot_path):
       img = cv2.imread(screenshot_path)
       gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
       
       # Detect edges and contours
       edges = cv2.Canny(gray, 50, 150)
       contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
       
       # Calculate whitespace ratio
       total_area = img.shape[0] * img.shape[1]
       content_area = sum(cv2.contourArea(c) for c in contours)
       whitespace_ratio = (total_area - content_area) / total_area
       
       return whitespace_ratio
   ```

2. **CTA Visibility Checker**
   - Identifies buttons via computer vision
   - Checks above/below fold placement
   - Analyzes color contrast against background
   - Measures button size for mobile touch targets
   ```python
   from wcag_contrast_ratio import rgb, passes_AA, passes_AAA
   
   def analyze_contrast(foreground_color, background_color):
       ratio = rgb(foreground_color, background_color)
       return {
           'ratio': ratio,
           'AA': passes_AA(ratio),
           'AAA': passes_AAA(ratio)
       }
   ```

3. **Form Complexity Scorer**
   - Counts form fields
   - Identifies required vs optional
   - Compares against conversion benchmarks
   - Best practice: 3-5 fields optimal for conversion

4. **Visual Hierarchy Analyzer**
   - Detects heading sizes and structure
   - Checks font size consistency
   - Identifies competing visual elements
   - Validates proper H1-H6 tag usage

**Implementation Stack**:
- **Core Libraries**:
  - `opencv-python`: Computer vision for layout analysis
  - `Pillow (PIL)`: Image processing
  - `BeautifulSoup4`: DOM parsing and structure analysis
  - `axe-core`: Accessibility testing (via pyppeteer)
  - `pa11y`: CLI accessibility testing
  - `lighthouse`: Performance and SEO analysis
  - `wcag-contrast-ratio`: Color contrast calculations
- **Web Automation**:
  - `selenium` or `playwright`: Dynamic content rendering
  - `pyppeteer`: Headless Chrome automation
- **All running on Raspberry Pi as part of unified scanner**

**Key Analysis Libraries**:
- **axe-core**: 70+ accessibility tests, minimal false positives
- **Pa11y**: CLI-focused, uses axe-core or HTML_CodeSniffer engines
- **Lighthouse**: Google's tool for performance, accessibility, SEO, PWA
- **WAVE API**: WCAG 2.0/2.1/2.2 compliance checking

**Performance Considerations**:
- axe-core + Pa11y combined find ~35% of accessibility issues
- OpenCV operations are CPU-intensive - optimize for Pi's ARM processor
- Cache analysis results to avoid re-processing
- Batch multiple analyses for efficiency

**Mobile Responsiveness Testing**:
```python
from selenium import webdriver

def test_responsive_design(url, viewports):
    driver = webdriver.Chrome()
    results = []
    
    # Standard viewport sizes
    viewports = [
        {'name': 'Mobile', 'width': 375, 'height': 667},
        {'name': 'Tablet', 'width': 768, 'height': 1024},
        {'name': 'Desktop', 'width': 1920, 'height': 1080}
    ]
    
    for viewport in viewports:
        driver.set_window_size(viewport['width'], viewport['height'])
        driver.get(url)
        
        # Take screenshot
        screenshot = driver.get_screenshot_as_png()
        
        # Analyze layout issues
        results.append({
            'viewport': viewport,
            'screenshot': screenshot,
            'issues': analyze_layout_issues(screenshot)
        })
    
    return results
```

**Integration with Unified Scanner**:
```python
class UXAnalyzer:
    def __init__(self):
        self.axe_path = '/usr/local/bin/axe'
        self.pa11y_path = '/usr/local/bin/pa11y'
        
    async def analyze_ux(self, url, screenshots):
        results = await asyncio.gather(
            self.run_accessibility_tests(url),
            self.analyze_whitespace(screenshots['desktop']),
            self.analyze_cta_visibility(screenshots['desktop']),
            self.test_responsive_design(url),
            self.check_color_contrast(url)
        )
        
        return {
            'accessibility': results[0],
            'whitespace_ratio': results[1],
            'cta_analysis': results[2],
            'responsive_issues': results[3],
            'contrast_issues': results[4],
            'overall_ux_score': self.calculate_ux_score(results)
        }
```

**Infrastructure Requirements**:
- Netlify deployment for Next.js frontend
- Supabase for:
  - PostgreSQL database
  - Realtime job status updates
  - File storage for reports/screenshots
  - Authentication and Row Level Security
- Raspberry Pi 5 (16GB) for all processing:
  - Runs all analysis tools locally
  - Polls Supabase for new jobs
  - Uploads results to Supabase storage
  - No cloud functions needed
- Email sending infrastructure (Amazon SES)
- Simple architecture = lower costs and complexity

**Raspberry Pi Processing Architecture**:
All analysis runs on the Pi, eliminating serverless complexity:

```python
# unified_scanner.py - Runs on Pi
class UnifiedWebScanner:
    def __init__(self):
        self.browser = self.setup_chromium()  # Shared browser instance
        self.supabase = create_client(url, key)
        
    async def process_job(self, job):
        url = job['target_url']
        
        # Run all analyses in parallel where possible
        results = await asyncio.gather(
            self.run_wappalyzer(url),
            self.run_lighthouse(url),
            self.run_accessibility(url),
            self.run_security_scan(url),
            self.capture_screenshots(url)
        )
        
        # Process UX analysis on screenshots
        ux_results = self.analyze_ux(results['screenshots'])
        
        # Upload results to Supabase
        report_url = await self.upload_report(results)
        
        # Update job status
        await self.supabase.table('jobs').update({
            'status': 'completed',
            'report_url': report_url
        }).eq('id', job['id']).execute()
```

**Benefits of Pi-based processing**:
- No timeout limits (analyses can run as long as needed)
- Shared browser instance (more efficient)
- Local caching of common resources
- No cold starts or billing surprises
- Complete control over the environment


## AI Email Generation System

**Configuration Options**:
- **Tone**: Professional, Friendly, Urgent, Educational, Consultative
- **Length**: Short (3-4 paragraphs), Medium (5-6), Detailed (7-8)
- **Focus**: Technical issues, Business impact, Cost savings, Competitive advantage
- **Style**: Direct, Story-based, Problem-solution, Data-driven

**AI Input Data**:
- Business name, owner name, website URL
- Top 3-5 issues with conversion impact percentages
- Outdated technologies detected
- Accessibility/performance scores
- Competitor comparison data (optional)

**Generated Email Structure**:
1. Personalized greeting with business name
2. Compelling hook about their specific issues
3. Top 3 improvement areas with impact data
4. Social proof or case study reference
5. Clear CTA to book free consultation via Calendly
6. Professional signature with contact info

**Example Output**:
"Hi [Owner Name], I noticed [Business Name]'s website has a 2:1 contrast ratio on your main call-to-action button. Studies show fixing this could increase conversions by 20-25%. I also found 2 other quick wins that could significantly boost your online revenue. I'd love to show you exactly how in a free 15-minute consultation. [Book time on Calendly]"

**Example with Security Upsell**:
"Hi [Owner Name], our analysis found [Business Name]'s website is missing critical security headers and running WordPress 4.2 with 47 known vulnerabilities. Beyond the security risks, we also identified 3 UX improvements that could boost conversions by 40%+. I'd love to discuss both the immediate fixes and our comprehensive security audit service. [Book time on Calendly]"

## Level 1 Security Scanner Implementation

**Core Components**:
```python
# /api/security-scan.py
class SecurityScanner:
    def __init__(self):
        self.sslyze = SSLyzeScanner()
        self.nvd_api_key = os.getenv('NIST_API_KEY')
    
    def scan_website(self, domain, tech_stack):
        return {
            'ssl_analysis': self.check_ssl(domain),
            'security_headers': self.check_headers(domain),
            'vulnerabilities': self.check_cves(tech_stack),
            'blacklist_status': self.check_blacklists(domain),
            'email_security': self.check_email_security(domain)
        }
```

**SSL/TLS Analysis**:
- Certificate validation and expiry
- Cipher suite strength assessment  
- Protocol version checks (TLS 1.0/1.1 deprecated)
- Known vulnerabilities (Heartbleed, POODLE, ROBOT)
- Overall grade calculation (A+ to F)

**Security Headers Check**:
- X-Frame-Options (clickjacking protection)
- Content-Security-Policy (XSS protection)
- Strict-Transport-Security (HTTPS enforcement)
- X-Content-Type-Options (MIME sniffing)
- Referrer-Policy (privacy)
- Permissions-Policy (feature control)

**CVE Vulnerability Detection**:
- Cross-reference WappalyzerGo results with NIST NVD
- Identify critical vulnerabilities in detected versions
- Priority scoring based on CVSS scores
- Generate remediation recommendations

**Reputation Checking**:
- Google Safe Browsing API status
- DNS-based blacklists (Spamhaus, SURBL)
- SSL certificate transparency logs
- Domain age and registration details

**Email Security Validation**:
- SPF record presence and validity
- DKIM selector detection
- DMARC policy analysis
- MX record configuration

## Level 2 Security Testing Implementation (Hybrid Architecture)

**Architecture Overview**:
The system uses a simplified architecture where Netlify hosts the static frontend, Supabase handles all data and real-time updates, and the Raspberry Pi 5 performs ALL analysis and testing. This eliminates serverless functions entirely.

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Netlify Static │  HTTPS  │    Supabase      │  Poll   │  Raspberry Pi 5 │
│   Next.js UI    │────────▶│                  │◀────────│ All Processing  │
│                 │         │ - PostgreSQL DB  │         │ - WappalyzerGo  │
│ - Lead Search   │         │ - Realtime       │         │ - Lighthouse    │
│ - Job Creation  │         │ - File Storage   │         │ - Pa11y/axe     │
│ - Report View   │         │ - Auth/RLS       │         │ - Security      │
└─────────────────┘         └──────────────────┘         └─────────────────┘
         ▲                           │                             │
         │                           ▼                             ▼
         │                  ┌──────────────────┐         ┌─────────────────┐
         └──────────────────│ Supabase Storage │◀────────│   All Analysis  │
                           │ - Reports (PDF)   │         │ - Level 1 & 2   │
                           │ - Screenshots     │         │ - UX Testing    │
                           │ - Job Results     │         │ - Unified Flow  │
                           └──────────────────┘         └─────────────────┘
```

**Implementation Flow**:
1. **Lead Collection & Job Creation** (Netlify/Supabase)
   ```javascript
   // Next.js frontend - no API routes needed
   import { createClient } from '@supabase/supabase-js'
   
   const supabase = createClient(url, anonKey)
   
   // Create analysis job
   async function createAnalysisJob(leadId) {
     const { data, error } = await supabase
       .from('analysis_jobs')
       .insert({
         lead_id: leadId,
         status: 'pending',
         type: 'full_analysis' // or 'level2_security'
       })
       .select()
       
     // Listen for real-time updates
     supabase
       .channel(`job:${data.id}`)
       .on('postgres_changes', {
         event: 'UPDATE',
         schema: 'public',
         table: 'analysis_jobs',
         filter: `id=eq.${data.id}`
       }, payload => {
         updateUIWithProgress(payload.new)
       })
       .subscribe()
   }
   ```

2. **Pi Worker Processing** (Supabase Polling)
   ```python
   # Runs on Raspberry Pi 5
   from supabase import create_client
   import asyncio
   
   class UnifiedWorker:
       def __init__(self):
           self.supabase = create_client(url, service_key)
           self.scanner = UnifiedWebScanner()
           
       async def run(self):
           while True:
               # Poll for pending jobs
               result = self.supabase.table('analysis_jobs')\
                   .select('*')\
                   .eq('status', 'pending')\
                   .order('created_at')\
                   .limit(1)\
                   .execute()
               
               if result.data:
                   await self.process_job(result.data[0])
               else:
                   await asyncio.sleep(30)
           async def process_job(self, job):
           job_id = job['id']
           lead_id = job['lead_id']
           
           # Update status to processing
           self.supabase.table('analysis_jobs').update({
               'status': 'processing',
               'started_at': 'now()'
           }).eq('id', job_id).execute()
           
           try:
               # Get lead details
               lead = self.supabase.table('leads')\
                   .select('*')\
                   .eq('id', lead_id)\
                   .single()\
                   .execute()
               
               # Run unified analysis
               if job['type'] == 'full_analysis':
                   results = await self.scanner.full_analysis(lead.data['website_url'])
               elif job['type'] == 'level2_security':
                   results = await self.scanner.level2_security(lead.data['website_url'])
               
               # Upload report to Supabase Storage
               report_path = f"reports/{job_id}.json"
               self.supabase.storage.from_('reports').upload(
                   report_path,
                   json.dumps(results)
               )
               
               # Update job with results
               self.supabase.table('analysis_jobs').update({
                   'status': 'completed',
                   'completed_at': 'now()',
                   'report_url': report_path,
                   'summary': results['summary']
               }).eq('id', job_id).execute()
               
           except Exception as e:
               self.supabase.table('analysis_jobs').update({
                   'status': 'failed',
                   'error': str(e)
               }).eq('id', job_id).execute()
   ```

3. **Result Delivery** (Supabase Storage → Netlify)
   ```javascript
   // Real-time updates in the UI
   const { data: report } = await supabase
     .storage
     .from('reports')
     .download(`reports/${jobId}.json`)
   
   // Display results with signed URL for PDFs
   const { data: signedUrl } = await supabase
     .storage
     .from('reports')
     .createSignedUrl(`reports/${jobId}.pdf`, 3600) // 1 hour
   ```

**Legal Requirements**:
1. **Authorization Documentation**:
   - Signed Penetration Testing Agreement
   - Rules of Engagement (RoE) document
   - Defined scope and boundaries
   - Emergency contact procedures
   - Third-party consent (for cloud services)

2. **Compliance Considerations**:
   - Testing windows to minimize disruption
   - Data handling procedures
   - Liability insurance requirements
   - Evidence preservation protocols

**Technical Infrastructure**:
```yaml
# Docker-based testing environment
services:
  owasp-zap:
    image: owasp/zap2docker-stable
    capabilities: ['NET_ADMIN']
  
  openvas:
    image: mikesplain/openvas
    ports: ['443:443']
  
  sqlmap:
    build: ./tools/sqlmap
    volumes: ['./reports:/output']
```

**Core Testing Workflow**:
```python
class Level2SecurityService:
    def __init__(self):
        self.zap = ZAPv2(proxy='http://localhost:8090')
        self.nmap = nmap.PortScanner()
        
    def run_penetration_test(self, target, auth_token):
        # 1. Verify authorization
        if not self.verify_legal_auth(auth_token):
            raise UnauthorizedException()
        
        # 2. Run scans with safety controls
        results = {
            'recon': self.reconnaissance(target),
            'ports': self.port_scan(target),
            'webapp': self.webapp_scan(target),
            'vulns': self.vulnerability_assessment(target)
        }
        
        # 3. Generate professional report
        return self.generate_pentest_report(results)
```

**Safety Controls**:
- Rate limiting (10 req/sec max)
- Concurrent scan limits (5 threads)
- Automated backups before testing
- Real-time monitoring and kill switches
- Scope validation on every request

**Deliverables**:
- Executive summary with risk ratings
- Technical vulnerability details with CVE references
- Proof-of-concept code (safely demonstrated)
- Prioritized remediation plan
- Compliance mapping (PCI DSS, HIPAA, etc.)
- Retest validation after fixes

## Level 2 Security Testing Pricing Tiers

### Basic Assessment ($500)
**Scope**: Single application, up to 10 pages/endpoints
**Testing**: Automated OWASP Top 10 scanning
**Deliverables**: Basic technical report (10-15 pages)
**Turnaround**: 3-5 business days

### Standard Assessment ($1000)
**Scope**: Medium application, up to 50 pages/endpoints
**Testing**: OWASP Top 10 + authentication testing
**Deliverables**: Detailed report (20-30 pages), 1 retest
**Turnaround**: 5-7 business days

### Comprehensive Assessment ($1500)
**Scope**: Large application, up to 100 pages/endpoints
**Testing**: Full penetration test including:
- OWASP Top 10
- API security testing
- Session management testing
- Business logic testing
**Deliverables**: Executive report (30-40 pages), 2 retests
**Turnaround**: 7-10 business days

### Enterprise Assessment ($2000)
**Scope**: Complex application, 100+ endpoints
**Testing**: Advanced testing including:
- Everything in Comprehensive
- Role-based access control testing
- Multi-tenant security validation
- Integration testing
- Compliance mapping (PCI DSS, HIPAA)
**Deliverables**: Professional report (40-60 pages), quarterly retests, compliance documentation
**Turnaround**: 10-14 business days

## Technical Implementation for All Tiers

### 1. Enhanced Testing Configuration Interface
```javascript
// Vercel UI for test configuration
const TestConfigForm = () => {
  return (
    <form>
      {/* Basic Configuration (All Tiers) */}
      <section>
        <h3>Target Configuration</h3>
        <input name="targetUrl" placeholder="https://example.com" />
        <select name="tier">
          <option value="basic">Basic ($500)</option>
          <option value="standard">Standard ($1000)</option>
          <option value="comprehensive">Comprehensive ($1500)</option>
          <option value="enterprise">Enterprise ($2000)</option>
        </select>
      </section>

      {/* Authentication Testing (Standard+) */}
      {tier >= 'standard' && (
        <section>
          <h3>Test Accounts</h3>
          <AccountCredentials role="admin" />
          <AccountCredentials role="user" />
          <AccountCredentials role="guest" />
          <input name="mfaEnabled" type="checkbox" /> Test MFA bypass
        </section>
      )}

      {/* Business Logic Testing (Comprehensive+) */}
      {tier >= 'comprehensive' && (
        <section>
          <h3>Business Logic Tests</h3>
          <checkbox name="priceManipulation" /> Price manipulation
          <checkbox name="workflowBypass" /> Workflow bypass
          <checkbox name="raceConditions" /> Race condition testing
          <CustomTestScenarios />
        </section>
      )}

      {/* Compliance Mapping (Enterprise) */}
      {tier === 'enterprise' && (
        <section>
          <h3>Compliance Requirements</h3>
          <checkbox name="pciDss" /> PCI DSS v4.0
          <checkbox name="hipaa" /> HIPAA
          <checkbox name="soc2" /> SOC 2
        </section>
      )}
    </form>
  );
};
```

### 2. Session Management Testing Tools
```python
# session_tester.py - Runs on Pi
import requests
import hashlib
import re

class SessionTester:
    def __init__(self, target_url, cookies):
        self.target = target_url
        self.session = requests.Session()
        self.results = []
        
    def test_session_fixation(self):
        """Test if application accepts externally set session IDs"""
        # Create fixed session ID
        fixed_sid = "FIXED123456789"
        self.session.cookies.set('SESSIONID', fixed_sid)
        
        # Attempt login
        response = self.session.post(f"{self.target}/login", data=self.creds)
        
        # Check if session ID changed after auth
        if self.session.cookies.get('SESSIONID') == fixed_sid:
            self.results.append({
                'vulnerability': 'Session Fixation',
                'severity': 'High',
                'description': 'Application accepts pre-set session IDs'
            })
    
    def test_session_entropy(self):
        """Analyze randomness of session tokens"""
        tokens = []
        for _ in range(100):
            resp = requests.get(self.target)
            token = self.extract_session_token(resp)
            tokens.append(token)
            
        # Calculate entropy
        entropy = self.calculate_entropy(tokens)
        if entropy < 128:
            self.results.append({
                'vulnerability': 'Weak Session Tokens',
                'severity': 'Medium',
                'entropy_bits': entropy
            })
    
    def test_concurrent_sessions(self):
        """Test multiple simultaneous sessions"""
        # Implementation for concurrent session testing
        pass
```

### 3. Business Logic Testing Framework
```python
# business_logic_tester.py
class BusinessLogicTester:
    def __init__(self, config):
        self.config = config
        self.results = []
        
    def test_price_manipulation(self):
        """Test for client-side price tampering"""
        # Add item to cart
        cart_data = self.add_to_cart(item_id='123', price='99.99')
        
        # Attempt to modify price
        tampered_data = cart_data.copy()
        tampered_data['price'] = '0.01'
        
        response = self.checkout(tampered_data)
        if response.status_code == 200:
            self.results.append({
                'vulnerability': 'Price Manipulation',
                'severity': 'Critical',
                'poc': 'Changed $99.99 to $0.01 successfully'
            })
    
    def test_race_conditions(self):
        """Test for TOCTOU vulnerabilities"""
        import threading
        
        def use_coupon(coupon_code):
            return self.session.post('/apply-coupon', 
                                   data={'code': coupon_code})
        
        # Attempt to use same coupon multiple times
        threads = []
        for _ in range(10):
            t = threading.Thread(target=use_coupon, args=('SAVE20',))
            threads.append(t)
            t.start()
            
        # Check if coupon applied multiple times
        for t in threads:
            t.join()
```

### 4. Authentication Testing Suite
```python
# auth_tester.py
class AuthenticationTester:
    def __init__(self, target, wordlist_path):
        self.target = target
        self.wordlist = self.load_wordlist(wordlist_path)
        
    def test_password_policy(self):
        """Test password complexity requirements"""
        weak_passwords = [
            'password', '123456', 'admin', 'test123',
            'P@ssw0rd', 'qwerty', self.target_domain
        ]
        
        for pwd in weak_passwords:
            if self.try_register(password=pwd):
                self.report_weakness(f"Accepts weak password: {pwd}")
    
    def test_account_lockout(self):
        """Test brute force protection"""
        username = 'testuser'
        
        # Attempt 50 failed logins
        for i in range(50):
            self.login(username, f'wrong{i}')
            
        # Check if account locked
        if self.login(username, 'correct_password'):
            self.report_vulnerability('No account lockout mechanism')
    
    def test_password_reset(self):
        """Test password reset security"""
        # Request reset
        token = self.request_reset('user@example.com')
        
        # Analyze token
        if self.is_predictable_token(token):
            self.report_vulnerability('Predictable reset tokens')
```

### 5. Role-Based Access Control Testing
```python
# rbac_tester.py
class RBACTester:
    def __init__(self, users_config):
        self.users = users_config  # {role: credentials}
        self.access_matrix = {}
        
    def test_horizontal_privilege_escalation(self):
        """Test access between same-privilege users"""
        # Login as User A
        session_a = self.login(self.users['user_a'])
        user_a_data = self.get_user_data(session_a, user_id='A')
        
        # Try to access User B's data with User A's session
        user_b_data = self.get_user_data(session_a, user_id='B')
        
        if user_b_data.status_code == 200:
            self.report_vulnerability('Horizontal privilege escalation')
    
    def test_vertical_privilege_escalation(self):
        """Test elevation to higher privileges"""
        # Login as regular user
        user_session = self.login(self.users['user'])
        
        # Attempt admin functions
        admin_endpoints = [
            '/admin/users', '/admin/settings', 
            '/api/v1/admin/export'
        ]
        
        for endpoint in admin_endpoints:
            if self.can_access(user_session, endpoint):
                self.report_vulnerability(f'User can access {endpoint}')
    
    def build_access_matrix(self):
        """Map all role/endpoint combinations"""
        roles = ['guest', 'user', 'moderator', 'admin']
        endpoints = self.discover_all_endpoints()
        
        for role in roles:
            session = self.login(self.users[role])
            for endpoint in endpoints:
                can_access = self.test_access(session, endpoint)
                self.access_matrix[(role, endpoint)] = can_access
```

### 6. API Security Testing
```python
# api_tester.py
class APISecurityTester:
    def __init__(self, api_base, swagger_url=None):
        self.api_base = api_base
        self.endpoints = self.discover_endpoints(swagger_url)
        
    def test_authentication_bypass(self):
        """Test API endpoints without auth"""
        for endpoint in self.endpoints:
            # Try without auth header
            resp = requests.get(f"{self.api_base}{endpoint}")
            if resp.status_code == 200:
                self.report_vulnerability(f'No auth required: {endpoint}')
    
    def test_rate_limiting(self):
        """Test API rate limits"""
        endpoint = f"{self.api_base}/api/users"
        
        # Hammer endpoint
        responses = []
        for _ in range(1000):
            resp = requests.get(endpoint)
            responses.append(resp.status_code)
            
        if all(r == 200 for r in responses):
            self.report_vulnerability('No rate limiting detected')
    
    def test_injection_points(self):
        """Test all parameters for injection"""
        # SQL, NoSQL, Command injection tests
        pass
```

### 7. Compliance Mapping
```python
# compliance_mapper.py
class ComplianceMapper:
    def __init__(self, standard='PCI_DSS'):
        self.standard = standard
        self.requirements = self.load_requirements(standard)
        
    def map_findings_to_compliance(self, vulnerabilities):
        """Map security findings to compliance requirements"""
        mapping = {}
        
        for vuln in vulnerabilities:
            affected_reqs = self.get_affected_requirements(vuln)
            for req in affected_reqs:
                mapping[req] = mapping.get(req, [])
                mapping[req].append(vuln)
                
        return self.generate_compliance_report(mapping)
    
    def generate_compliance_matrix(self):
        """Create compliance coverage matrix"""
        matrix = {
            'PCI_DSS_11.3': 'Penetration testing performed',
            'PCI_DSS_6.5': 'Application vulnerabilities addressed',
            'HIPAA_164.308': 'Access controls tested',
            # ... more mappings
        }
        return matrix
```

### 8. Advanced Reporting Engine
```python
# report_generator.py
class AdvancedReportGenerator:
    def __init__(self, tier='basic'):
        self.tier = tier
        self.sections = self.get_sections_for_tier(tier)
        
    def generate_report(self, test_results):
        report = {
            'executive_summary': self.generate_executive_summary(),
            'risk_matrix': self.create_risk_matrix(),
            'technical_findings': self.format_vulnerabilities(),
        }
        
        if self.tier >= 'comprehensive':
            report['poc_videos'] = self.generate_poc_links()
            report['remediation_timeline'] = self.create_timeline()
            
        if self.tier == 'enterprise':
            report['compliance_mapping'] = self.map_to_compliance()
            report['security_roadmap'] = self.create_roadmap()
            
        return self.render_to_pdf(report)
```

### 9. Testing Orchestration
```javascript
// Enhanced job creation with tier configuration
export async function createLevel2Job(data) {
  const { tier, targetUrl, testConfig } = data;
  
  const jobConfig = {
    basic: {
      tests: ['owasp_top10', 'ssl_scan'],
      report_sections: ['findings', 'recommendations']
    },
    standard: {
      tests: [...basic.tests, 'auth_testing', 'session_testing'],
      report_sections: [...basic.report_sections, 'executive_summary']
    },
    comprehensive: {
      tests: [...standard.tests, 'business_logic', 'api_testing'],
      report_sections: [...standard.report_sections, 'poc_evidence']
    },
    enterprise: {
      tests: [...comprehensive.tests, 'rbac_testing', 'compliance'],
      report_sections: [...comprehensive.report_sections, 'compliance_matrix']
    }
  };
  
  const job = await db.query(`
    INSERT INTO pentest_jobs (
      client_id, target_url, scope, tier, test_config, price
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [clientId, targetUrl, scope, tier, jobConfig[tier], TIER_PRICING[tier]]);
  
  return job.rows[0];
}

## Development Environment Workflow

### Project Structure
```
ReactionGears-Marketing/
├── web/                        # Next.js/Vercel frontend
│   ├── pages/
│   ├── components/
│   └── api/                   # Vercel serverless functions
├── pi-worker/                 # Raspberry Pi security testing
│   ├── Dockerfile             # Production ARM64 build
│   ├── Dockerfile.dev         # Development with hot reload
│   ├── docker-compose.yml     # Production compose
│   ├── docker-compose.dev.yml # Development compose
│   ├── requirements.txt       # Python dependencies
│   ├── src/
│   │   ├── worker.py         # Main job processor
│   │   ├── testers/          # Security testing modules
│   │   │   ├── __init__.py
│   │   │   ├── session_tester.py
│   │   │   ├── auth_tester.py
│   │   │   ├── business_logic_tester.py
│   │   │   ├── rbac_tester.py
│   │   │   └── api_tester.py
│   │   └── utils/            # Shared utilities
│   └── tests/                # Test suites
├── shared/                    # Shared types and schemas
├── scripts/                   # Deployment and utilities
│   ├── deploy-to-pi.sh       # Deploy to Raspberry Pi
│   ├── setup-dev.sh          # Setup local development
│   └── run-tests.sh          # Run test suites
└── mock-targets/             # Local vulnerable apps for testing

### Local Development Setup (macOS)

#### 1. Initial Setup
```bash
# Clone repository
git clone <repo-url>
cd ReactionGears-Marketing

# Install Docker Desktop for Mac with experimental features
# Enable "Use Docker Compose V2" in settings

# Setup Docker buildx for ARM64 cross-compilation
docker buildx create --name pibuilder --use
docker buildx inspect --bootstrap

# Run setup script
./scripts/setup-dev.sh
```

#### 2. Development Docker Configuration
```yaml
# pi-worker/docker-compose.dev.yml
version: '3.8'

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: reactiongears_dev
      POSTGRES_PASSWORD: devpassword
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  pi-worker:
    build:
      context: .
      dockerfile: Dockerfile.dev
    platform: linux/arm64/v8  # Emulate Pi architecture
    volumes:
      - ./src:/app/src  # Hot reload for development
      - ./tests:/app/tests
    environment:
      - DEV_MODE=true
      - DATABASE_URL=postgresql://postgres:devpassword@postgres:5432/reactiongears_dev
      - LOG_LEVEL=DEBUG
    depends_on:
      - postgres
    command: python -m watchdog.auto_restart --patterns="*.py" --recursive -- python src/worker.py

  mock-vulnerable-app:
    build: ../mock-targets
    ports:
      - "8080:8080"
    environment:
      - VULNERABLE_MODE=true

volumes:
  postgres_data:
```

#### 3. Development Dockerfile
```dockerfile
# pi-worker/Dockerfile.dev
FROM --platform=linux/arm64/v8 python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    git \
    nmap \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt

# Install watchdog for hot reload
RUN pip install watchdog

# Copy application code
COPY . .

# Development entrypoint
CMD ["python", "-m", "watchdog.auto_restart", "--patterns=*.py", "--recursive", "--", "python", "src/worker.py"]
```

### Development Workflow

#### 1. Local Development Cycle
```bash
# Start development environment
cd pi-worker
docker-compose -f docker-compose.dev.yml up

# In another terminal, run tests continuously
docker-compose -f docker-compose.dev.yml exec pi-worker pytest -w

# Make code changes - they auto-reload
vim src/testers/session_tester.py

# Run specific tests
docker-compose -f docker-compose.dev.yml exec pi-worker pytest tests/test_session.py -v
```

#### 2. Testing Strategy
```bash
# Unit tests (fast, run on every save)
pytest tests/unit/ -v

# Integration tests (test with mock vulnerable apps)
pytest tests/integration/ -v --mock-target=http://mock-vulnerable-app:8080

# E2E tests (test full workflow)
pytest tests/e2e/ -v --database-url=$DATABASE_URL
```

#### 3. Building for Production
```bash
# Build ARM64 image for Pi
docker buildx build \
  --platform linux/arm64 \
  -t reactiongears/pi-worker:latest \
  -f Dockerfile \
  --push \
  .
```

### Deployment to Raspberry Pi

#### 1. Deployment Script
```bash
#!/bin/bash
# scripts/deploy-to-pi.sh

set -e

# Configuration
PI_HOST="${PI_HOST:-pentest@192.168.1.100}"
PI_DIR="/home/pentest/worker"
REGISTRY="${REGISTRY:-docker.io}"
IMAGE="reactiongears/pi-worker:latest"

echo "🔨 Building ARM64 image..."
docker buildx build \
  --platform linux/arm64 \
  -t $REGISTRY/$IMAGE \
  -f pi-worker/Dockerfile \
  --push \
  ./pi-worker

echo "📦 Deploying to Pi..."
ssh $PI_HOST << EOF
  cd $PI_DIR
  docker-compose pull
  docker-compose down
  docker-compose up -d
  docker-compose logs -f --tail=50
EOF

echo "✅ Deployment complete!"
```

#### 2. Production Docker Compose (on Pi)
```yaml
# On Pi: /home/pentest/worker/docker-compose.yml
version: '3.8'

services:
  worker:
    image: reactiongears/pi-worker:latest
    restart: unless-stopped
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - STORAGE_BUCKET=${STORAGE_BUCKET}
      - LOG_LEVEL=INFO
    volumes:
      - ./reports:/app/reports
      - ./logs:/app/logs
    network_mode: host  # Required for penetration testing

  # Local monitoring
  prometheus:
    image: prom/prometheus:latest
    platform: linux/arm64
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
```

### CI/CD Pipeline

#### GitHub Actions Workflow
```yaml
# .github/workflows/pi-worker-deploy.yml
name: Deploy Pi Worker

on:
  push:
    branches: [main]
    paths: ['pi-worker/**']

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up QEMU for ARM64
        uses: docker/setup-qemu-action@v2
        
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
        
      - name: Run tests
        run: |
          cd pi-worker
          docker buildx build --platform linux/arm64 -t test-image -f Dockerfile.test .
          docker run --rm test-image pytest tests/

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
          
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: ./pi-worker
          platforms: linux/arm64
          push: true
          tags: reactiongears/pi-worker:latest
          
      - name: Deploy to Pi
        uses: appleboy/ssh-action@v0.1.5
        with:
          host: ${{ secrets.PI_HOST }}
          username: ${{ secrets.PI_USER }}
          key: ${{ secrets.PI_SSH_KEY }}
          script: |
            cd /home/pentest/worker
            docker-compose pull
            docker-compose up -d
```

### Mock Vulnerable Applications

#### Local Testing Targets
```python
# mock-targets/app.py
from flask import Flask, request, session, jsonify
import time

app = Flask(__name__)
app.secret_key = 'intentionally-weak-key'

# Vulnerable endpoints for testing

@app.route('/login', methods=['POST'])
def vulnerable_login():
    """Session fixation vulnerability"""
    username = request.form.get('username')
    password = request.form.get('password')
    
    # Bad: Accepts session ID from client
    if 'sessionid' in request.cookies:
        session.permanent = True
    
    if username == 'admin' and password == 'admin':
        session['user'] = username
        return jsonify({'status': 'success'})
    return jsonify({'status': 'failed'})

@app.route('/api/cart/checkout', methods=['POST'])
def vulnerable_checkout():
    """Price manipulation vulnerability"""
    cart = request.json
    # Bad: Trusts client-provided prices
    total = sum(item['price'] * item['quantity'] for item in cart['items'])
    return jsonify({'total': total, 'status': 'processed'})

@app.route('/api/users/<user_id>')
def vulnerable_idor(user_id):
    """IDOR vulnerability"""
    # Bad: No authorization check
    users = {
        '1': {'name': 'Alice', 'ssn': '123-45-6789'},
        '2': {'name': 'Bob', 'ssn': '987-65-4321'}
    }
    return jsonify(users.get(user_id, {}))

@app.route('/search')
def vulnerable_sqli():
    """SQL injection vulnerability"""
    query = request.args.get('q', '')
    # Bad: Direct string concatenation
    sql = f"SELECT * FROM products WHERE name LIKE '%{query}%'"
    return jsonify({'sql': sql, 'results': []})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=True)
```

### Development Best Practices

1. **Always develop in Docker** - Ensures consistency with Pi environment
2. **Use ARM64 platform flag** - Catches architecture-specific issues early
3. **Test against mock targets** - Safe, repeatable testing
4. **Automate deployments** - Reduces errors and saves time
5. **Monitor Pi resources** - 16GB RAM is plenty but monitor during tests
6. **Use version tags** - Tag releases for easy rollbacks
7. **Keep secrets secure** - Use environment variables, never commit credentials

# Logical Dependency Chain
1. **Data Foundation** (Must be built first):
   - Database schema setup
   - Basic CRUD for prospects
   - Simple web interface
   
2. **Analysis Core** (Provides value proposition):
   - Website performance analyzer
   - Issue detection algorithms
   - Screenshot capture system
   
3. **Automated Analysis** (Provides immediate value):
   - WappalyzerGo integration for all leads
   - Bulk website scanning
   - Tech stack categorization
   - Outdated technology flagging
   
4. **Email Engine** (Enables outreach):
   - AI email generation with Claude/GPT-4
   - Tone/style configuration system
   - HTML email builder
   - Manual send approval workflow
   - Open/click tracking
   - Automated follow-up sequences
   
5. **Automation Layer** (Scales the system):
   - Zipcode-based discovery automation
   - Automatic website scanning pipeline
   - Campaign scheduling
   - Follow-up sequences
   - Response detection
   
5. **Optimization Tools** (Improves results):
   - A/B testing framework
   - Analytics dashboard
   - Lead scoring
   - Performance insights

# Risks and Mitigations
**Email Deliverability**:
- Risk: Emails marked as spam hurt domain reputation
- Mitigation: Gradual sending ramp-up, proper authentication, quality over quantity

**Data Accuracy**:
- Risk: Incorrect contact info wastes time and hurts metrics
- Mitigation: Email verification before sending, bounce handling

**Analysis Accuracy**:
- Risk: False positives make us look incompetent
- Mitigation: Conservative thresholds, human review option for edge cases

**Rate Limiting**:
- Risk: Hit API limits during bulk analysis
- Mitigation: Queue management, caching, multiple API keys

**Legal Compliance**:
- Risk: CAN-SPAM/GDPR violations
- Mitigation: Proper opt-out handling, data retention policies, geographic filtering

# Third-Party Services Cost Analysis

## Service Breakdown (Updated for Manual Analysis)

**Google PageSpeed Insights API**
- Cost: FREE
- Limits: 25,000 queries/day
- Usage: 5-10 websites/week = 20-40 queries/month
- Notes: Well within free tier limits

**Tech Stack Detection**
- WappalyzerGo: FREE (open source, self-hosted)
- Deployment: Vercel Serverless Functions with Go runtime
- Usage: 5-10 websites/week = 20-40 lookups/month
- Notes: No API costs, unlimited usage

**Email Discovery**
- Apollo.io: FREE (60 email credits/month)
- Hunter.io: $49/month (500 searches)
- Clearbit: $99+/month (expensive at $0.40+ per contact)
- Usage: 5-10 emails/week = 20-40 searches/month
- Notes: Apollo free tier perfectly matches our needs

**Email Delivery**
- SendGrid: $19.95/month (50,000 emails)
- Amazon SES: $0.10 per 1,000 emails
- Usage: 5-10 initial emails + follow-ups = ~100 emails/month
- Notes: Amazon SES essentially free at this volume

**Screenshot & UX Analysis**
- Puppeteer (self-hosted): ~$30/month server costs
- Usage: 100 websites × 3-5 screenshots = 300-500 screenshots/month
- UX Analysis Tools:
  - Lighthouse: FREE (open source)
  - Pa11y: FREE (open source)
  - axe-core: FREE (open source)
  - Custom Python/OpenCV tools: FREE (we build)
- Notes: All UX analysis tools are free, only cost is VPS for screenshots

**Domain/SSL Checkers**
- WhoisXML API: $29/month minimum
- SSL Labs API: FREE
- Own implementation: FREE
- Usage: 5-10 checks/week = 20-40 checks/month

## Recommended Approach for Low Volume (5-10 websites/week)

**With Raspberry Pi Architecture (~$30/month recurring)**
- **One-Time Costs**:
  - Raspberry Pi 5 (16GB): ~$150-200
  - All analysis tools: FREE (open source on Pi)
    - WappalyzerGo, Lighthouse, Pa11y/axe-core
    - Custom Python/OpenCV tools
    - Security scanners (SSLyze, secheaders, etc.)
    - Screenshot generation via Puppeteer/Playwright

- **Monthly Costs**:
  - Apollo.io: FREE (60 email credits/month)
  - Amazon SES: ~$1/month for email delivery
  - Supabase: FREE tier (database, storage, realtime)
  - Netlify: FREE tier (static hosting)
  - Optional API upgrades: ~$29/month if needed
  - Total: ~$30/month or less

**Benefits of Pi-Based Approach**:
- No per-scan costs or API rate limits
- All processing happens locally - unlimited analyses
- No timeout issues for complex scans
- Complete control over the environment
- Can handle 100+ automatic scans/month
- Manual review of best 5-10 for outreach
- ROI: One client pays for entire year of operation

## ROI Justification (Auto-Scan + Manual Selection Model)
- Average website project value: $5,000-15,000
- Collect & scan 100 businesses/month automatically
- Pre-qualified by outdated tech: ~30-40 good leads
- Manually select best 5-10 for outreach
- Expected conversion rate: 5-10% of contacted
- At 7.5% conversion, expect 1-3 clients per month
- Minimal cost option ($30/month) pays for itself with any project
- Auto-scanning saves hours of manual research

## Cost Optimization Strategies (With Raspberry Pi Architecture)
1. One-time Pi hardware investment (~$150-200) eliminates most recurring costs
2. All analysis tools run locally on Pi - no API costs or rate limits
3. Use Apollo.io free tier (60 credits/month) for email discovery
4. Amazon SES for essentially free email delivery at this volume
5. Supabase free tier handles database and storage needs
6. Netlify free tier for static hosting
7. Only recurring costs: ~$30/month total (mainly for any API upgrades if needed)

# Appendix
**Research Findings**:
- Emails mentioning specific website issues get 5x higher response rates
- Best time to send B2B emails: Tuesday-Thursday, 10am-2pm
- Follow-up sequences increase response rates by 160%
- 70% of SMB websites have significant performance issues

**Technical Specifications**:
- Process 100+ automatic website scans per month
- Zipcode-based lead collection (100 businesses/month)
- Automatic WappalyzerGo scanning for all websites
- Send up to 10-20 personalized emails per week (manually selected)
- Store all scan results indefinitely
- Track email engagement for 30 days
- Support for multiple email templates
- Export functionality for all data
- Lead filtering by technology stack

# Development Roadmap

## MVP (Phase 1) - Core Functionality
**Infrastructure Setup**:
- [ ] Set up Netlify account and Next.js deployment
- [ ] Configure Supabase project with database schema
- [ ] Set up Raspberry Pi 5 with Docker environment
- [ ] Configure secure connection between Pi and Supabase

**Lead Discovery & Collection**:
- [ ] Implement zipcode search interface
- [ ] Create Netlify Functions for Google Places API integration
- [ ] Add Yelp API integration for business data
- [ ] Build lead deduplication logic
- [ ] Create leads table in Supabase with proper schema

**Automated Analysis (Pi Worker)**:
- [ ] Set up unified scanner architecture on Pi
- [ ] Integrate WappalyzerGo for tech detection
- [ ] Implement Lighthouse for performance analysis
- [ ] Add Pa11y/axe-core for accessibility testing
- [ ] Create Level 1 security scanner (SSL, headers, CVEs)
- [ ] Build UX analysis tools (whitespace, CTA placement)
- [ ] Implement Supabase polling mechanism
- [ ] Create report generation and upload system

**Email Generation & Sending**:
- [ ] Integrate Claude Code SDK in Netlify Function
- [ ] Build email generation UI with tone/style options
- [ ] Create email preview and editing interface
- [ ] Set up Amazon SES integration
- [ ] Implement email tracking (pixel and click tracking)
- [ ] Create email events logging in Supabase

**Dashboard & Reporting**:
- [ ] Build lead management dashboard
- [ ] Create real-time job status updates
- [ ] Implement report viewing interface
- [ ] Add email campaign metrics display
- [ ] Create lead filtering and search

## Phase 2 - Enhanced Features
**Advanced Analysis**:
- [ ] Add screenshot annotation for issues
- [ ] Implement detailed performance metrics
- [ ] Create comprehensive UX scoring system
- [ ] Add mobile responsiveness analysis
- [ ] Build technology version detection

**Email Campaign Automation**:
- [ ] Create follow-up email sequences
- [ ] Implement Supabase cron jobs for scheduling
- [ ] Build email template management
- [ ] Add A/B testing for subject lines
- [ ] Create engagement scoring system

**Level 2 Security Testing**:
- [ ] Build test configuration interface
- [ ] Implement session management testing
- [ ] Add authentication testing suite
- [ ] Create business logic testing framework
- [ ] Build professional report generator

**Lead Enhancement**:
- [ ] Add batch zipcode processing
- [ ] Implement Apollo.io integration improvements
- [ ] Create lead scoring algorithm
- [ ] Build competitor analysis features

## Phase 3 - Enterprise Features
**Advanced Security**:
- [ ] Implement RBAC testing capabilities
- [ ] Add API security testing suite
- [ ] Create compliance mapping (PCI DSS, HIPAA)
- [ ] Build multi-tenant security testing
- [ ] Add quarterly retest scheduling

**AI & Intelligence**:
- [ ] Enhanced AI email variations
- [ ] Predictive lead scoring with ML
- [ ] Industry-specific issue detection
- [ ] Automated insight generation

**Enterprise Features**:
- [ ] White-label report generation
- [ ] Multi-user support with roles
- [ ] Advanced Calendly integration
- [ ] CRM integration options
- [ ] Automated invoicing for Level 2 tests

**Future Considerations**:
- [ ] Level 3 security testing (stress/load testing)
- [ ] International market support
- [ ] Mobile app for lead management
- [ ] Partner API for agencies

## Technical Debt & Optimization
**Performance**:
- [ ] Implement caching strategies
- [ ] Optimize Pi resource usage
- [ ] Add CDN for report delivery
- [ ] Improve scan parallelization

**Monitoring & Reliability**:
- [ ] Add comprehensive logging
- [ ] Implement error alerting
- [ ] Create backup strategies
- [ ] Add health check endpoints

**Developer Experience**:
- [ ] Improve local development setup
- [ ] Add comprehensive testing suite
- [ ] Create deployment automation
- [ ] Build documentation site

This roadmap reflects the complete system architecture with Netlify hosting, Supabase backend, and Raspberry Pi processing, focusing on practical implementation while maintaining scalability for future growth.
</PRD>