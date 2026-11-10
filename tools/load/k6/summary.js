const OUT = __ENV.LOAD_OUT || "/out";
const RUN = __ENV.LOAD_RUN || "run";

function line(name, metric) {
  const values = metric.values;
  if (metric.type === "trend") {
    const parts = ["avg", "med", "p(95)", "p(99)", "max"]
      .filter((key) => values[key] !== undefined)
      .map((key) => `${key}=${values[key].toFixed(1)}`);
    return `${name} ${parts.join(" ")}`;
  }
  if (metric.type === "counter")
    return `${name} count=${values.count} rate=${values.rate.toFixed(2)}/s`;
  if (metric.type === "rate") return `${name} rate=${(values.rate * 100).toFixed(2)}%`;
  return `${name} ${JSON.stringify(values)}`;
}

export function summaryOf(data, kind, parameters) {
  const metrics = {};
  const lines = [`${kind} ${RUN} ${JSON.stringify(parameters)}`];
  for (const name of Object.keys(data.metrics).sort()) {
    const metric = data.metrics[name];
    metrics[name] = { type: metric.type, values: metric.values };
    lines.push(line(name, metric));
  }
  const report = {
    kind,
    run: RUN,
    parameters,
    testRunDurationMs: data.state.testRunDurationMs,
    metrics,
  };
  return {
    stdout: `${lines.join("\n")}\n`,
    [`${OUT}/${RUN}.json`]: `${JSON.stringify(report, null, 2)}\n`,
  };
}
