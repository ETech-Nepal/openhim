export function operationOutcome(code, diagnostics, expression) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code,
      diagnostics,
      ...(expression?.length ? { expression } : {}),
    }],
  };
}
