import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import { z } from 'zod';

import {
	log,
	writeJSON,
	enableSilentMode,
	disableSilentMode,
	isSilentMode,
	readJSON,
	findTaskById
} from '../utils.js';

import { generateObjectService } from '../ai-services-unified.js';
import { getDebugFlag, getMainProvider } from '../config-manager.js';
import generateTaskFiles from './generate-task-files.js';
import { displayAiUsageSummary } from '../ui.js';

// Define the Zod schema for a SINGLE task object
const prdSingleTaskSchema = z.object({
	id: z.number().int().positive(),
	title: z.string().min(1),
	description: z.string().min(1),
	details: z.string().optional().default(''),
	testStrategy: z.string().optional().default(''),
	priority: z.enum(['high', 'medium', 'low']).default('medium'),
	dependencies: z.array(z.number().int().positive()).optional().default([]),
	status: z.string().optional().default('pending')
});

// Define the Zod schema for the ENTIRE expected AI response object
const prdResponseSchema = z.object({
	tasks: z.array(prdSingleTaskSchema),
	metadata: z.object({
		projectName: z.string(),
		totalTasks: z.number(),
		sourceFile: z.string(),
		generatedAt: z.string()
	})
});

/**
 * Parse PRD content into sections based on markdown headers
 * @param {string} prdContent - The PRD content
 * @returns {Array<{title: string, level: number, content: string, lineCount: number}>}
 */
function parsePRDIntoSections(prdContent) {
	const lines = prdContent.split('\n');
	const sections = [];
	let currentSection = null;
	let overviewContent = '';
	let inOverview = true;
	
	lines.forEach((line, index) => {
		// Check for section markers first
		if (line.includes('<!-- TASK-SECTION:') && line.includes('START -->')) {
			const titleMatch = line.match(/<!-- TASK-SECTION:\s*(.+?)\s*START -->/);
			if (titleMatch) {
				if (currentSection) {
					sections.push(currentSection);
				}
				currentSection = {
					title: titleMatch[1],
					level: 0, // Section markers are top level
					content: '',
					lineCount: 0,
					isMarked: true
				};
				inOverview = false;
				return;
			}
		}
		
		if (line.includes('<!-- TASK-SECTION:') && line.includes('END -->')) {
			if (currentSection) {
				sections.push(currentSection);
				currentSection = null;
			}
			return;
		}
		
		// Check for markdown headers
		const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
		
		if (headerMatch && !currentSection?.isMarked) {
			const level = headerMatch[1].length;
			const title = headerMatch[2].trim();
			
			// Skip headers that look like code comments or installation steps
			const isCodeComment = title.startsWith('!') || title.startsWith('/') || 
			                     title.includes('.py') || title.includes('.sh') || 
			                     title.includes('.yml') || title.includes('.json');
			const isInstallStep = title.match(/^(Install|Setup|Enable|Run|Start|Make|Build|Clone)\s/i);
			
			// Only create new sections for level 1 and 2 headers that aren't code/steps
			if (level <= 2 && !isCodeComment && !isInstallStep) {
				if (currentSection) {
					sections.push(currentSection);
				}
				
				currentSection = {
					title: title,
					level: level,
					content: line + '\n',
					lineCount: 1,
					isMarked: false
				};
				inOverview = false;
			} else if (currentSection) {
				// Add level 3 headers to current section
				currentSection.content += line + '\n';
				currentSection.lineCount++;
			}
		} else if (currentSection) {
			// Add content to current section
			currentSection.content += line + '\n';
			currentSection.lineCount++;
		} else if (inOverview) {
			// Collect overview content (before first section)
			overviewContent += line + '\n';
		}
	});
	
	// Don't forget the last section
	if (currentSection) {
		sections.push(currentSection);
	}
	
	// Add overview as a special section at the beginning
	if (overviewContent.trim()) {
		sections.unshift({
			title: 'Project Overview',
			level: 0,
			content: overviewContent,
			lineCount: overviewContent.split('\n').length,
			isOverview: true
		});
	}
	
	return sections;
}

/**
 * Group sections into task batches based on size and content
 * @param {Array} sections - Parsed sections
 * @param {number} totalTasks - Total number of tasks to generate
 * @returns {Array<{name: string, sections: Array, suggestedTasks: number}>}
 */
function groupSectionsForTasks(sections, totalTasks) {
	// Filter out overview section for task counting
	const taskSections = sections.filter(s => !s.isOverview);
	const overview = sections.find(s => s.isOverview);
	
	// If we have way more sections than tasks requested, we need to be more aggressive about grouping
	const tooManySections = taskSections.length > totalTasks * 1.5;
	
	// Group small sections together, keep large sections separate
	const groups = [];
	let currentGroup = null;
	const MAX_LINES_PER_GROUP = tooManySections ? 800 : 500; // More aggressive grouping if too many sections
	const MIN_LINES_FOR_OWN_GROUP = tooManySections ? 500 : 300; // Raise threshold if too many sections
	
	taskSections.forEach(section => {
		// Large sections get their own group
		if (section.lineCount > MIN_LINES_FOR_OWN_GROUP || section.level === 1) {
			if (currentGroup) {
				groups.push(currentGroup);
				currentGroup = null;
			}
			groups.push({
				name: section.title,
				sections: [section],
				lineCount: section.lineCount,
				isLarge: true
			});
		} else {
			// Small sections can be grouped
			if (!currentGroup || currentGroup.lineCount + section.lineCount > MAX_LINES_PER_GROUP) {
				if (currentGroup) {
					groups.push(currentGroup);
				}
				currentGroup = {
					name: section.title,
					sections: [section],
					lineCount: section.lineCount,
					isLarge: false
				};
			} else {
				currentGroup.sections.push(section);
				currentGroup.lineCount += section.lineCount;
				currentGroup.name = `${currentGroup.sections[0].title} + ${currentGroup.sections.length - 1} more`;
			}
		}
	});
	
	// Add last group
	if (currentGroup) {
		groups.push(currentGroup);
	}
	
	// Distribute tasks proportionally based on content size
	const totalLines = groups.reduce((sum, g) => sum + g.lineCount, 0);
	
	// First pass: distribute proportionally with minimum of 1
	groups.forEach(group => {
		const proportion = group.lineCount / totalLines;
		group.suggestedTasks = Math.max(1, Math.round(totalTasks * proportion));
	});
	
	// Adjust to match exact total
	let currentTotal = groups.reduce((sum, g) => sum + g.suggestedTasks, 0);
	
	// If we have too many tasks, reduce from largest groups
	while (currentTotal > totalTasks) {
		const largestGroup = groups
			.filter(g => g.suggestedTasks > 1)
			.reduce((max, g) => (g.suggestedTasks > max.suggestedTasks ? g : max), { suggestedTasks: 0 });
		
		if (largestGroup.suggestedTasks > 1) {
			largestGroup.suggestedTasks--;
			currentTotal--;
		} else {
			break; // Can't reduce further
		}
	}
	
	// If we have too few tasks, add to largest groups
	while (currentTotal < totalTasks) {
		const largestGroup = groups.reduce((max, g) => 
			g.lineCount > max.lineCount ? g : max
		);
		largestGroup.suggestedTasks++;
		currentTotal++;
	}
	
	// Add overview reference to each group
	groups.forEach(group => {
		group.overview = overview?.content || '';
	});
	
	return groups;
}

/**
 * Parse a PRD file and generate tasks
 * @param {string} prdPath - Path to the PRD file
 * @param {string} tasksPath - Path to the tasks.json file
 * @param {number} numTasks - Number of tasks to generate
 * @param {Object} options - Additional options
 * @param {boolean} [options.force=false] - Whether to overwrite existing tasks.json.
 * @param {boolean} [options.append=false] - Append to existing tasks file.
 * @param {boolean} [options.research=false] - Use research model for enhanced PRD analysis.
 * @param {Object} [options.reportProgress] - Function to report progress (optional, likely unused).
 * @param {Object} [options.mcpLog] - MCP logger object (optional).
 * @param {Object} [options.session] - Session object from MCP server (optional).
 * @param {string} [options.projectRoot] - Project root path (for MCP/env fallback).
 * @param {string} [outputFormat='text'] - Output format ('text' or 'json').
 */
async function parsePRD(prdPath, tasksPath, numTasks, options = {}) {
	const {
		reportProgress,
		mcpLog,
		session,
		projectRoot,
		force = false,
		append = false,
		research = false,
		spinner = null
	} = options;
	const isMCP = !!mcpLog;
	const outputFormat = isMCP ? 'json' : 'text';

	const logFn = mcpLog
		? mcpLog
		: {
				// Wrapper for CLI
				info: (...args) => log('info', ...args),
				warn: (...args) => log('warn', ...args),
				error: (...args) => log('error', ...args),
				debug: (...args) => log('debug', ...args),
				success: (...args) => log('success', ...args)
			};

	// Create custom reporter using logFn
	const report = (message, level = 'info') => {
		// Check logFn directly
		if (logFn && typeof logFn[level] === 'function') {
			logFn[level](message);
		} else if (!isSilentMode() && outputFormat === 'text') {
			// Fallback to original log only if necessary and in CLI text mode
			log(level, message);
		}
	};

	report(
		`Parsing PRD file: ${prdPath}, Force: ${force}, Append: ${append}, Research: ${research}`
	);

	let existingTasks = [];
	let nextId = 1;
	let aiServiceResponse = null;

	try {
		// Handle file existence and overwrite/append logic
		if (fs.existsSync(tasksPath)) {
			if (append) {
				report(
					`Append mode enabled. Reading existing tasks from ${tasksPath}`,
					'info'
				);
				const existingData = readJSON(tasksPath); // Use readJSON utility
				if (existingData && Array.isArray(existingData.tasks)) {
					existingTasks = existingData.tasks;
					if (existingTasks.length > 0) {
						nextId = Math.max(...existingTasks.map((t) => t.id || 0)) + 1;
						report(
							`Found ${existingTasks.length} existing tasks. Next ID will be ${nextId}.`,
							'info'
						);
					}
				} else {
					report(
						`Could not read existing tasks from ${tasksPath} or format is invalid. Proceeding without appending.`,
						'warn'
					);
					existingTasks = []; // Reset if read fails
				}
			} else if (!force) {
				// Not appending and not forcing overwrite
				const overwriteError = new Error(
					`Output file ${tasksPath} already exists. Use --force to overwrite or --append.`
				);
				report(overwriteError.message, 'error');
				if (outputFormat === 'text') {
					console.error(chalk.red(overwriteError.message));
					process.exit(1);
				} else {
					throw overwriteError;
				}
			} else {
				// Force overwrite is true
				report(
					`Force flag enabled. Overwriting existing file: ${tasksPath}`,
					'info'
				);
			}
		}

		report(`Reading PRD content from ${prdPath}`, 'info');
		const prdContent = fs.readFileSync(prdPath, 'utf8');
		if (!prdContent) {
			throw new Error(`Input file ${prdPath} is empty or could not be read.`);
		}

		// Check if we should auto-enable append mode for claude-code provider
		const currentProvider = getMainProvider(projectRoot);
		const isClaudeCode = currentProvider === 'claude-code';
		let useAppend = append;
		let useForce = force;
		let tasksPerBatch = numTasks; // Start with the requested number of tasks

		// Check PRD size for more intelligent batching
		const prdSizeKB = Math.round(Buffer.byteLength(prdContent) / 1024);
		const prdLines = prdContent.split('\n').length;
		
		// Debug logging
		report(
			`DEBUG: Provider=${currentProvider}, isClaudeCode=${isClaudeCode}, numTasks=${numTasks}, PRD size=${prdSizeKB}KB (${prdLines} lines)`,
			'info'
		);
		
		// Check if we should use section-based parsing for large PRDs
		const useSectionParsing = (prdSizeKB > 30 || prdLines > 1000) && numTasks >= 10;
		
		if (useSectionParsing) {
			report(
				`Large PRD detected (${prdSizeKB}KB, ${prdLines} lines). Using section-based parsing for better results.`,
				'info'
			);
			
			// Parse PRD into sections
			const sections = parsePRDIntoSections(prdContent);
			report(
				`Found ${sections.length} sections in PRD.`,
				'info'
			);
			
			// Preview task distribution
			const taskGroups = groupSectionsForTasks(sections, numTasks);
			const actualTaskCount = taskGroups.reduce((sum, g) => sum + g.suggestedTasks, 0);
			
			// Warn if task count doesn't match
			if (actualTaskCount !== numTasks && !isMCP) {
				report(
					`Warning: Due to section structure, this will create ${actualTaskCount} tasks instead of ${numTasks}.`,
					'warn'
				);
				
				// Only prompt in CLI mode, not MCP
				if (outputFormat === 'text') {
					// Stop spinner before showing prompt
					if (spinner) {
						spinner.stop();
					}
					
					const inquirer = await import('inquirer');
					const { proceed } = await inquirer.default.prompt([{
						type: 'confirm',
						name: 'proceed',
						message: `Found ${sections.length} sections, which will create ${actualTaskCount} tasks. Proceed?`,
						default: false
					}]);
					
					if (!proceed) {
						report('Operation cancelled by user.', 'info');
						if (spinner) {
							spinner.fail('Operation cancelled by user.');
						}
						process.exit(0);
					}
					
					// Restart spinner if continuing
					if (spinner) {
						spinner.start('Generating tasks from sections...');
					}
				}
			}
			
			// Use section-based parsing
			return await parsePRDWithSections(
				prdPath,
				tasksPath,
				actualTaskCount, // Use actual count instead of requested
				prdContent,
				sections,
				existingTasks,
				nextId,
				{
					reportProgress,
					mcpLog,
					session,
					projectRoot,
					force: useForce,
					append: useAppend,
					research,
					spinner
				}
			);
		}
		
		// Original batching logic for smaller PRDs or when not using claude-code
		if (isClaudeCode && numTasks >= 5 && !append) {
			report(
				`Detected claude-code provider with ${numTasks} tasks. PRD size: ${prdSizeKB}KB, ${prdLines} lines.`,
				'info'
			);
			report(
				`Auto-enabling batch mode with append.`,
				'info'
			);
			useAppend = true;
			
			// Dynamic batch sizing based on PRD size and task count
			if (prdSizeKB > 60 || prdLines > 1800) {
				// Extremely large PRD - use single task batches
				tasksPerBatch = 1;
			} else if (prdSizeKB > 50 || prdLines > 1500) {
				// Very large PRD - use tiny batches
				tasksPerBatch = 2;
			} else if (prdSizeKB > 30 || prdLines > 1000 || numTasks >= 20) {
				// Large PRD or many tasks - use small batches
				tasksPerBatch = 3;
			} else {
				// Normal PRD - use medium batches
				tasksPerBatch = 4;
			}
			
			report(
				`Using ${tasksPerBatch} tasks per batch to avoid truncation due to PRD size.`,
				'info'
			);
		}

		// Handle batching for claude-code provider
		report(
			`DEBUG: Batching check - isClaudeCode=${isClaudeCode}, numTasks=${numTasks}, tasksPerBatch=${tasksPerBatch}, should batch=${isClaudeCode && numTasks >= 5 && tasksPerBatch < numTasks}`,
			'info'
		);
		
		if (isClaudeCode && numTasks >= 5 && tasksPerBatch < numTasks) {
			report(`Entering batch mode: ${numTasks} tasks in batches of ${tasksPerBatch}`, 'info');
			return await parsePRDInBatches(
				prdPath,
				tasksPath,
				numTasks,
				tasksPerBatch,
				prdContent,
				existingTasks,
				nextId,
				{
					reportProgress,
					mcpLog,
					session,
					projectRoot,
					useForce,
					useAppend: true, // Always use append for batches after the first
					research
				}
			);
		}

		// Research-specific enhancements to the system prompt
		const researchPromptAddition = research
			? `\nBefore breaking down the PRD into tasks, you will:
1. Research and analyze the latest technologies, libraries, frameworks, and best practices that would be appropriate for this project
2. Identify any potential technical challenges, security concerns, or scalability issues not explicitly mentioned in the PRD without discarding any explicit requirements or going overboard with complexity -- always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches
3. Consider current industry standards and evolving trends relevant to this project (this step aims to solve LLM hallucinations and out of date information due to training data cutoff dates)
4. Evaluate alternative implementation approaches and recommend the most efficient path
5. Include specific library versions, helpful APIs, and concrete implementation guidance based on your research
6. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches

Your task breakdown should incorporate this research, resulting in more detailed implementation guidance, more accurate dependency mapping, and more precise technology recommendations than would be possible from the PRD text alone, while maintaining all explicit requirements and best practices and all details and nuances of the PRD.`
			: '';

		// Base system prompt for PRD parsing
		const systemPrompt = `You are an AI assistant specialized in analyzing Product Requirements Documents (PRDs) and generating a structured, logically ordered, dependency-aware and sequenced list of development tasks in JSON format.${researchPromptAddition}

Analyze the provided PRD content and generate approximately ${tasksPerBatch} top-level development tasks. If the complexity or the level of detail of the PRD is high, generate more tasks relative to the complexity of the PRD
Each task should represent a logical unit of work needed to implement the requirements and focus on the most direct and effective way to implement the requirements without unnecessary complexity or overengineering. Include pseudo-code, implementation details, and test strategy for each task. Find the most up to date information to implement each task.
Assign sequential IDs starting from ${nextId}. Infer title, description, details, and test strategy for each task based *only* on the PRD content.
Set status to 'pending', dependencies to an empty array [], and priority to 'medium' initially for all tasks.
Respond ONLY with a valid JSON object containing a single key "tasks", where the value is an array of task objects adhering to the provided Zod schema. Do not include any explanation or markdown formatting.

Each task should follow this JSON structure:
{
	"id": number,
	"title": string,
	"description": string,
	"status": "pending",
	"dependencies": number[] (IDs of tasks this depends on),
	"priority": "high" | "medium" | "low",
	"details": string (implementation details),
	"testStrategy": string (validation approach)
}

Guidelines:
1. Unless complexity warrants otherwise, create exactly ${tasksPerBatch} tasks, numbered sequentially starting from ${nextId}
2. Each task should be atomic and focused on a single responsibility following the most up to date best practices and standards
3. Order tasks logically - consider dependencies and implementation sequence
4. Early tasks should focus on setup, core functionality first, then advanced features
5. Include clear validation/testing approach for each task
6. Set appropriate dependency IDs (a task can only depend on tasks with lower IDs, potentially including existing tasks with IDs less than ${nextId} if applicable)
7. Assign priority (high/medium/low) based on criticality and dependency order
8. Include detailed implementation guidance in the "details" field${research ? ', with specific libraries and version recommendations based on your research' : ''}
9. If the PRD contains specific requirements for libraries, database schemas, frameworks, tech stacks, or any other implementation details, STRICTLY ADHERE to these requirements in your task breakdown and do not discard them under any circumstance
10. Focus on filling in any gaps left by the PRD or areas that aren't fully specified, while preserving all explicit requirements
11. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches${research ? '\n12. For each task, include specific, actionable guidance based on current industry standards and best practices discovered through research' : ''}`;

		// Build user prompt with PRD content
		const userPrompt = `Here's the Product Requirements Document (PRD) to break down into approximately ${tasksPerBatch} tasks, starting IDs from ${nextId}:${research ? '\n\nRemember to thoroughly research current best practices and technologies before task breakdown to provide specific, actionable implementation details.' : ''}\n\n${prdContent}\n\n

Return your response in this format:
{
    "tasks": [
        {
            "id": ${nextId},
            "title": "Setup Project Repository",
            "description": "...",
            ...
        },
        ...
    ],
    "metadata": {
        "projectName": "PRD Implementation",
        "totalTasks": ${tasksPerBatch},
        "sourceFile": "${prdPath}",
        "generatedAt": "YYYY-MM-DD"
    }
}`;

		// Call the unified AI service
		report(
			`Calling AI service to generate tasks from PRD${research ? ' with research-backed analysis' : ''}...`,
			'info'
		);

		// Call generateObjectService with the CORRECT schema and additional telemetry params
		aiServiceResponse = await generateObjectService({
			role: research ? 'research' : 'main', // Use research role if flag is set
			session: session,
			projectRoot: projectRoot,
			schema: prdResponseSchema,
			objectName: 'tasks_data',
			systemPrompt: systemPrompt,
			prompt: userPrompt,
			commandName: 'parse-prd',
			outputType: isMCP ? 'mcp' : 'cli'
		});

		// Create the directory if it doesn't exist
		const tasksDir = path.dirname(tasksPath);
		if (!fs.existsSync(tasksDir)) {
			fs.mkdirSync(tasksDir, { recursive: true });
		}
		logFn.success(
			`Successfully parsed PRD via AI service${research ? ' with research-backed analysis' : ''}.`
		);

		// Validate and Process Tasks
		// Get the generated object from the response
		let generatedData = null;
		if (aiServiceResponse?.object) {
			if (
				typeof aiServiceResponse.object === 'object' &&
				aiServiceResponse.object !== null &&
				'tasks' in aiServiceResponse.object
			) {
				// The object property contains the generated data
				generatedData = aiServiceResponse.object;
			}
		}

		if (!generatedData || !Array.isArray(generatedData.tasks)) {
			logFn.error(
				`Internal Error: generateObjectService returned unexpected data structure: ${JSON.stringify(generatedData)}`
			);
			throw new Error(
				'AI service returned unexpected data structure after validation.'
			);
		}

		let currentId = nextId;
		const taskMap = new Map();
		const processedNewTasks = generatedData.tasks.map((task) => {
			const newId = currentId++;
			taskMap.set(task.id, newId);
			return {
				...task,
				id: newId,
				status: 'pending',
				priority: task.priority || 'medium',
				dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
				subtasks: []
			};
		});

		// Remap dependencies for the NEWLY processed tasks
		processedNewTasks.forEach((task) => {
			task.dependencies = task.dependencies
				.map((depId) => taskMap.get(depId)) // Map old AI ID to new sequential ID
				.filter(
					(newDepId) =>
						newDepId != null && // Must exist
						newDepId < task.id && // Must be a lower ID (could be existing or newly generated)
						(findTaskById(existingTasks, newDepId) || // Check if it exists in old tasks OR
							processedNewTasks.some((t) => t.id === newDepId)) // check if it exists in new tasks
				);
		});

		const finalTasks = useAppend
			? [...existingTasks, ...processedNewTasks]
			: processedNewTasks;
		const outputData = { tasks: finalTasks };

		// Write the final tasks to the file
		writeJSON(tasksPath, outputData);
		report(
			`Successfully ${useAppend ? 'appended' : 'generated'} ${processedNewTasks.length} tasks in ${tasksPath}${research ? ' with research-backed analysis' : ''}`,
			'success'
		);

		// Generate markdown task files after writing tasks.json
		await generateTaskFiles(tasksPath, path.dirname(tasksPath), { mcpLog });

		// Handle CLI output (e.g., success message)
		if (outputFormat === 'text') {
			console.log(
				boxen(
					chalk.green(
						`Successfully generated ${processedNewTasks.length} new tasks${research ? ' with research-backed analysis' : ''}. Total tasks in ${tasksPath}: ${finalTasks.length}`
					),
					{ padding: 1, borderColor: 'green', borderStyle: 'round' }
				)
			);

			console.log(
				boxen(
					chalk.white.bold('Next Steps:') +
						'\n\n' +
						`${chalk.cyan('1.')} Run ${chalk.yellow('task-master list')} to view all tasks\n` +
						`${chalk.cyan('2.')} Run ${chalk.yellow('task-master expand --id=<id>')} to break down a task into subtasks`,
					{
						padding: 1,
						borderColor: 'cyan',
						borderStyle: 'round',
						margin: { top: 1 }
					}
				)
			);

			if (aiServiceResponse && aiServiceResponse.telemetryData) {
				displayAiUsageSummary(aiServiceResponse.telemetryData, 'cli');
			}
		}

		// Return telemetry data
		return {
			success: true,
			tasksPath,
			telemetryData: aiServiceResponse?.telemetryData
		};
	} catch (error) {
		report(`Error parsing PRD: ${error.message}`, 'error');

		// Only show error UI for text output (CLI)
		if (outputFormat === 'text') {
			console.error(chalk.red(`Error: ${error.message}`));

			if (getDebugFlag(projectRoot)) {
				// Use projectRoot for debug flag check
				console.error(error);
			}

			process.exit(1);
		} else {
			throw error; // Re-throw for JSON output
		}
	}
}

/**
 * Parse PRD in batches for claude-code provider to avoid response truncation
 */
async function parsePRDInBatches(
	prdPath,
	tasksPath,
	totalTasks,
	tasksPerBatch,
	prdContent,
	existingTasks,
	startId,
	options
) {
	const { reportProgress, mcpLog, session, projectRoot, useForce, research } =
		options;
	const logFn = mcpLog || {
		info: (...args) => log('info', ...args),
		warn: (...args) => log('warn', ...args),
		error: (...args) => log('error', ...args),
		success: (...args) => log('success', ...args)
	};

	const report = (message, level = 'info') => {
		if (mcpLog) {
			mcpLog[level](message);
		} else {
			log(level, message);
		}
	};

	let currentId = startId;
	let remainingTasks = totalTasks;
	let batchNumber = 1;
	let isFirstBatch = true;

	report(
		`Starting batch processing: ${totalTasks} total tasks in batches of ${tasksPerBatch}`,
		'info'
	);

	while (remainingTasks > 0) {
		const currentBatchSize = Math.min(tasksPerBatch, remainingTasks);

		report(
			`Processing batch ${batchNumber}: ${currentBatchSize} tasks (starting from ID ${currentId})`,
			'info'
		);

		// For batches after the first, read existing tasks to get the current nextId
		if (!isFirstBatch) {
			const existingData = readJSON(tasksPath);
			if (existingData && Array.isArray(existingData.tasks)) {
				existingTasks = existingData.tasks;
				if (existingTasks.length > 0) {
					currentId = Math.max(...existingTasks.map((t) => t.id || 0)) + 1;
				}
			}
		}

		// Call the original parsePRD function for this batch
		await parsePRDSingleBatch(
			prdPath,
			tasksPath,
			currentBatchSize,
			currentId,
			prdContent,
			existingTasks,
			{
				reportProgress,
				mcpLog,
				session,
				projectRoot,
				useForce: isFirstBatch ? useForce : false,
				useAppend: !isFirstBatch, // First batch might overwrite, rest append
				tasksPerBatch: currentBatchSize, // Pass the actual batch size
				research
			}
		);

		remainingTasks -= currentBatchSize;
		batchNumber++;
		isFirstBatch = false;

		if (remainingTasks > 0) {
			report(
				`Batch ${batchNumber - 1} completed. ${remainingTasks} tasks remaining.`,
				'info'
			);
		}
	}

	report(
		`All ${totalTasks} tasks generated successfully across ${batchNumber - 1} batches!`,
		'success'
	);
}

/**
 * Single batch processing function (extracted from main parsePRD logic)
 */
async function parsePRDSingleBatch(
	prdPath,
	tasksPath,
	numTasks,
	nextId,
	prdContent,
	existingTasks,
	options
) {
	const {
		reportProgress,
		mcpLog,
		session,
		projectRoot,
		useForce,
		useAppend,
		tasksPerBatch,
		research
	} = options;
	const actualTasksPerBatch = tasksPerBatch || numTasks; // Fallback to numTasks if not provided
	const isMCP = !!mcpLog;
	const outputFormat = isMCP ? 'json' : 'text';

	const logFn = mcpLog || {
		info: (...args) => log('info', ...args),
		warn: (...args) => log('warn', ...args),
		error: (...args) => log('error', ...args),
		success: (...args) => log('success', ...args)
	};

	// Research-specific enhancements to the system prompt
	const researchPromptAddition = research
		? `\nBefore breaking down the PRD into tasks, you will:
1. Research and analyze the latest technologies, libraries, frameworks, and best practices that would be appropriate for this project
2. Identify any potential technical challenges, security concerns, or scalability issues not explicitly mentioned in the PRD without discarding any explicit requirements or going overboard with complexity -- always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches
3. Consider current industry standards and evolving trends relevant to this project (this step aims to solve LLM hallucinations and out of date information due to training data cutoff dates)
4. Evaluate alternative implementation approaches and recommend the most efficient path
5. Include specific library versions, helpful APIs, and concrete implementation guidance based on your research
6. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches

Your task breakdown should incorporate this research, resulting in more detailed implementation guidance, more accurate dependency mapping, and more precise technology recommendations than would be possible from the PRD text alone, while maintaining all explicit requirements and best practices and all details and nuances of the PRD.`
		: '';

	// Build system prompt for PRD parsing
	const systemPrompt = `You are an AI assistant specialized in analyzing Product Requirements Documents (PRDs) and generating a structured, logically ordered, dependency-aware and sequenced list of development tasks in JSON format.${researchPromptAddition}
Analyze the provided PRD content and generate approximately ${actualTasksPerBatch} top-level development tasks. If the complexity or the level of detail of the PRD is high, generate more tasks relative to the complexity of the PRD
Each task should represent a logical unit of work needed to implement the requirements and focus on the most direct and effective way to implement the requirements without unnecessary complexity or overengineering. Include pseudo-code, implementation details, and test strategy for each task. Find the most up to date information to implement each task.
Assign sequential IDs starting from ${nextId}. Infer title, description, details, and test strategy for each task based *only* on the PRD content.
Set status to 'pending', dependencies to an empty array [], and priority to 'medium' initially for all tasks.
Respond ONLY with a valid JSON object containing a single key "tasks", where the value is an array of task objects adhering to the provided Zod schema. Do not include any explanation or markdown formatting.

Each task should follow this JSON structure:
{
	"id": number,
	"title": string,
	"description": string,
	"status": "pending",
	"dependencies": number[] (IDs of tasks this depends on),
	"priority": "high" | "medium" | "low",
	"details": string (implementation details),
	"testStrategy": string (validation approach)
}

Guidelines:
1. Unless complexity warrants otherwise, create exactly ${actualTasksPerBatch} tasks, numbered sequentially starting from ${nextId}
2. Each task should be atomic and focused on a single responsibility following the most up to date best practices and standards
3. Order tasks logically - consider dependencies and implementation sequence
4. Early tasks should focus on setup, core functionality first, then advanced features
5. Include clear validation/testing approach for each task
6. Set appropriate dependency IDs (a task can only depend on tasks with lower IDs, potentially including existing tasks with IDs less than ${nextId} if applicable)
7. Assign priority (high/medium/low) based on criticality and dependency order
8. Include detailed implementation guidance in the "details" field${research ? ', with specific libraries and version recommendations based on your research' : ''}
9. If the PRD contains specific requirements for libraries, database schemas, frameworks, tech stacks, or any other implementation details, STRICTLY ADHERE to these requirements in your task breakdown and do not discard them under any circumstance
10. Focus on filling in any gaps left by the PRD or areas that aren't fully specified, while preserving all explicit requirements
11. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches${research ? '\n12. For each task, include specific, actionable guidance based on current industry standards and best practices discovered through research' : ''}`;

	// Build user prompt with PRD content
	const userPrompt = `Here's the Product Requirements Document (PRD) to break down into approximately ${actualTasksPerBatch} tasks, starting IDs from ${nextId}:${research ? '\n\nRemember to thoroughly research current best practices and technologies before task breakdown to provide specific, actionable implementation details.' : ''}\n\n${prdContent}\n\n

Return your response in this format:
{
    "tasks": [
        {
            "id": ${nextId},
            "title": "Setup Project Repository",
            "description": "...",
            ...
        },
        ...
    ],
    "metadata": {
        "projectName": "PRD Implementation",
        "totalTasks": ${actualTasksPerBatch},
        "sourceFile": "${prdPath}",
        "generatedAt": "YYYY-MM-DD"
    }
}`;

	// Call the unified AI service
	const aiServiceResponse = await generateObjectService({
		role: research ? 'research' : 'main',
		session: session,
		projectRoot: projectRoot,
		schema: prdResponseSchema,
		objectName: 'tasks_data',
		systemPrompt: systemPrompt,
		prompt: userPrompt,
		commandName: 'parse-prd',
		outputType: isMCP ? 'mcp' : 'cli'
	});

	// Process the response (same logic as main function)
	let generatedData = null;
	if (aiServiceResponse?.object) {
		if (
			typeof aiServiceResponse.object === 'object' &&
			aiServiceResponse.object !== null &&
			'tasks' in aiServiceResponse.object
		) {
			generatedData = aiServiceResponse.object;
		}
	}

	if (!generatedData || !Array.isArray(generatedData.tasks)) {
		logFn.error(
			`Internal Error: generateObjectService returned unexpected data structure: ${JSON.stringify(generatedData)}`
		);
		throw new Error(
			'AI service returned unexpected data structure after validation.'
		);
	}

	let currentId = nextId;
	const taskMap = new Map();
	const processedNewTasks = generatedData.tasks.map((task) => {
		const newId = currentId++;
		taskMap.set(task.id, newId);
		return {
			...task,
			id: newId,
			status: 'pending',
			priority: task.priority || 'medium',
			dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
			subtasks: []
		};
	});

	// Remap dependencies for the NEWLY processed tasks
	processedNewTasks.forEach((task) => {
		task.dependencies = task.dependencies
			.map((depId) => taskMap.get(depId))
			.filter(
				(newDepId) =>
					newDepId != null &&
					newDepId < task.id &&
					(findTaskById(existingTasks, newDepId) ||
						processedNewTasks.some((t) => t.id === newDepId))
			);
	});

	const finalTasks = useAppend
		? [...existingTasks, ...processedNewTasks]
		: processedNewTasks;
	const outputData = { tasks: finalTasks };

	// Write the final tasks to the file
	writeJSON(tasksPath, outputData);
	logFn.success(
		`Successfully ${useAppend ? 'appended' : 'generated'} ${processedNewTasks.length} tasks in ${tasksPath}${research ? ' with research-backed analysis' : ''}`
	);
}

/**
 * Parse PRD using section-based approach to avoid truncation
 */
async function parsePRDWithSections(
	prdPath,
	tasksPath,
	totalTasks,
	prdContent,
	sections,
	existingTasks,
	startId,
	options
) {
	const { reportProgress, mcpLog, session, projectRoot, force, append, research } = options;
	const isMCP = !!mcpLog;
	
	const logFn = mcpLog || {
		info: (...args) => log('info', ...args),
		warn: (...args) => log('warn', ...args),
		error: (...args) => log('error', ...args),
		success: (...args) => log('success', ...args)
	};
	
	const report = (message, level = 'info') => {
		if (mcpLog) {
			mcpLog[level](message);
		} else {
			log(level, message);
		}
	};
	
	// Group sections into task batches
	const taskGroups = groupSectionsForTasks(sections, totalTasks);
	report(`Organized PRD into ${taskGroups.length} task groups:`, 'info');
	taskGroups.forEach(group => {
		report(`  - ${group.name}: ${group.suggestedTasks} tasks`, 'info');
	});
	
	// Process each group
	let currentId = startId;
	let allGeneratedTasks = [];
	let isFirstGroup = true;
	const allTelemetryData = [];
	
	for (const group of taskGroups) {
		report(`\nProcessing section: ${group.name} (${group.suggestedTasks} tasks)`, 'info');
		
		// Build focused prompt for this section
		const sectionContent = group.sections.map(s => s.content).join('\n\n');
		const sectionSizeKB = Math.round(Buffer.byteLength(sectionContent) / 1024);
		report(`Section size: ${sectionSizeKB}KB`, 'debug');
		
		// Research-specific enhancements
		const researchPromptAddition = research
			? `\nBefore breaking down this section into tasks, research and analyze the latest technologies and best practices specific to the features described below.`
			: '';
			
		// Build system prompt with section context
		const systemPrompt = `You are analyzing a SECTION of a Product Requirements Document (PRD).${researchPromptAddition}

PROJECT OVERVIEW (for context only):
${group.overview.substring(0, 500)}${group.overview.length > 500 ? '...' : ''}

CURRENT SECTION: "${group.name}"
Generate exactly ${group.suggestedTasks} development tasks for ONLY the features described in this section.
Each task should be focused on implementing specific functionality from this section.

Guidelines:
1. Create exactly ${group.suggestedTasks} tasks, numbered sequentially starting from ${currentId}
2. Keep descriptions concise (under 300 characters)
3. Keep details field under 800 characters
4. Focus ONLY on features from this section
5. Tasks should be atomic and implementable
6. Set appropriate dependencies (only to tasks with lower IDs)

Respond ONLY with valid JSON matching this structure:
{
  "tasks": [...],
  "metadata": {
    "projectName": "string",
    "totalTasks": number,
    "sourceFile": "string", 
    "generatedAt": "YYYY-MM-DD"
  }
}`;

		const userPrompt = `Here is the section content to analyze:

${sectionContent}

Generate ${group.suggestedTasks} tasks starting from ID ${currentId}.

Return response in this format:
{
  "tasks": [
    {
      "id": ${currentId},
      "title": "...",
      "description": "...",
      "status": "pending",
      "priority": "medium",
      "dependencies": [],
      "details": "...",
      "testStrategy": "..."
    }
  ],
  "metadata": {
    "projectName": "${group.name} Implementation",
    "totalTasks": ${group.suggestedTasks},
    "sourceFile": "${prdPath}",
    "generatedAt": "${new Date().toISOString().split('T')[0]}"
  }
}`;

		try {
			// Call AI service for this section
			const aiServiceResponse = await generateObjectService({
				role: research ? 'research' : 'main',
				session: session,
				projectRoot: projectRoot,
				schema: prdResponseSchema,
				objectName: 'tasks_data',
				systemPrompt: systemPrompt,
				prompt: userPrompt,
				commandName: 'parse-prd-section',
				outputType: isMCP ? 'mcp' : 'cli'
			});
			
			// Process generated tasks
			if (aiServiceResponse?.object?.tasks) {
				const sectionTasks = aiServiceResponse.object.tasks;
				
				// Update IDs to ensure continuity
				const processedTasks = sectionTasks.map((task, index) => ({
					...task,
					id: currentId + index,
					status: 'pending',
					priority: task.priority || 'medium',
					dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
					subtasks: []
				}));
				
				// Validate and fix dependencies
				processedTasks.forEach(task => {
					task.dependencies = task.dependencies.filter(depId => 
						depId < task.id && 
						(depId < startId || allGeneratedTasks.some(t => t.id === depId))
					);
				});
				
				allGeneratedTasks.push(...processedTasks);
				currentId += processedTasks.length;
				
				report(`Generated ${processedTasks.length} tasks for section "${group.name}"`, 'success');
				
				// Collect telemetry
				if (aiServiceResponse.telemetryData) {
					allTelemetryData.push(aiServiceResponse.telemetryData);
				}
			}
		} catch (error) {
			report(`Error processing section "${group.name}": ${error.message}`, 'error');
			// Continue with other sections
		}
		
		// Write intermediate results after each section
		const intermediateData = {
			tasks: append || !isFirstGroup ? [...existingTasks, ...allGeneratedTasks] : allGeneratedTasks
		};
		writeJSON(tasksPath, intermediateData);
		isFirstGroup = false;
	}
	
	// Final summary
	const finalTasks = append ? [...existingTasks, ...allGeneratedTasks] : allGeneratedTasks;
	const outputData = { tasks: finalTasks };
	writeJSON(tasksPath, outputData);
	
	report(
		`Successfully generated ${allGeneratedTasks.length} tasks across ${taskGroups.length} sections`,
		'success'
	);
	
	// Generate markdown files
	await generateTaskFiles(tasksPath, path.dirname(tasksPath), { mcpLog });
	
	// Aggregate telemetry
	const aggregatedTelemetry = allTelemetryData.length > 0 ? 
		allTelemetryData.reduce((acc, data) => ({
			inputTokens: (acc.inputTokens || 0) + (data.inputTokens || 0),
			outputTokens: (acc.outputTokens || 0) + (data.outputTokens || 0),
			totalCost: (acc.totalCost || 0) + (data.totalCost || 0)
		}), {}) : null;
	
	// Return success with telemetry
	return {
		success: true,
		tasksPath,
		telemetryData: aggregatedTelemetry
	};
}

export default parsePRD;
export { parsePRDIntoSections, groupSectionsForTasks };
