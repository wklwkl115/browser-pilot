import { evaluationTasks } from "./lib/browser-eval-tasks.mjs";
import { parseEvaluationArgs, selectEvaluationTasks } from "./lib/evaluation-metrics.mjs";

const options = parseEvaluationArgs(process.argv.slice(2));
const tasks = selectEvaluationTasks(evaluationTasks, options);
if (options.list) {
	console.log(
		JSON.stringify(
			tasks.map(({ id, suite, kind }) => ({ id, suite, kind })),
			null,
			2,
		),
	);
} else {
	const { runBrowserEvaluation } = await import("./lib/browser-eval-runner.mjs");
	await runBrowserEvaluation(options, tasks);
}
