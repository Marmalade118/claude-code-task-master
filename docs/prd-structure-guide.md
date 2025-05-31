# PRD Structure Guide for Task Master

## The Problem

When parsing large PRDs (>50KB), Claude Code CLI has response length limitations that cause truncation errors. Even when generating just 1 task, the AI tries to synthesize the entire document, resulting in responses over 10,000 characters that get cut off.

## The Solution: Section-Based Task Generation

By structuring your PRD with clear section markers, Task Master can:
1. Parse the PRD into logical sections
2. Send only relevant sections when generating tasks
3. Reduce context size and avoid truncation
4. Generate more focused, accurate tasks

## Recommended PRD Structure

### Use Task Master Section Markers

Add these special markers to explicitly define task boundaries:

```markdown
<!-- TASK-SECTION: Lead Discovery START -->
# 1. Zipcode-Based Lead Discovery
   - What it does: Finds all small businesses in a zipcode
   - Implementation details...
<!-- TASK-SECTION: Lead Discovery END -->

<!-- TASK-SECTION: Website Analysis START -->
# 2. Automatic Website Analysis
   - What it does: Scans websites for issues
   - Implementation details...
<!-- TASK-SECTION: Website Analysis END -->
```

### Alternative: Structured Headers

If you can't use HTML comments, use a consistent header structure:

```markdown
# Project Overview
General context and goals...

# Core Features

## Feature 1: Lead Discovery
### Overview
### Technical Requirements
### Implementation Details

## Feature 2: Website Analysis  
### Overview
### Technical Requirements
### Implementation Details

# Technical Architecture
## Database Schema
## API Design
## Security Considerations
```

## Benefits of Section-Based Parsing

1. **Prevents Truncation**: Each section generates its own tasks with limited context
2. **Better Task Focus**: Tasks are specific to their feature area
3. **Logical Grouping**: Related tasks stay together
4. **Efficient Generation**: Smaller prompts = faster, more reliable responses

## Example: How Your PRD Would Be Parsed

With proper markers, your 63KB PRD would be split into:

```
Section 1: Overview (context only, 0-1 tasks)
Section 2: Lead Discovery (4-5 tasks)
Section 3: Website Analysis (5-6 tasks)  
Section 4: Email Generation (4-5 tasks)
Section 5: Campaign Management (3-4 tasks)
Section 6: Technical Architecture (8-10 tasks)
Section 7: Development Setup (4-5 tasks)
```

Each section would generate tasks independently, avoiding the 10,000 character limit.

## Quick Fix for Existing PRDs

Add these markers to your existing PRD at logical boundaries:

```markdown
<!-- TASK-MASTER: MAX-TASKS-PER-SECTION=5 -->
<!-- TASK-MASTER: SECTION-START: Core Features -->
# Core Features
...content...
<!-- TASK-MASTER: SECTION-END -->
```

## Implementation Status

This feature is planned but not yet implemented. For now:
1. The batching system (1 task at a time for large PRDs) helps but isn't perfect
2. Consider breaking your PRD into multiple files
3. Or manually run parse-prd on sections of your PRD

## Workaround: Manual Section Processing

Until section parsing is implemented, you can:

```bash
# Extract sections manually
head -n 500 full-prd.md > section1-overview.md
sed -n '501,1000p' full-prd.md > section2-features.md
sed -n '1001,1500p' full-prd.md > section3-tech.md

# Generate tasks for each section
task-master parse-prd section1-overview.md --num-tasks=5
task-master parse-prd section2-features.md --num-tasks=15 --append
task-master parse-prd section3-tech.md --num-tasks=10 --append
```

This gives you the benefits of section-based parsing today!