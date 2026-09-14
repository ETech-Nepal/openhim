export function operationOutcome(code: string, diagnostics: string, expression?: string[]) {
  return {
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code,
        diagnostics,
        ...(expression?.length ? { expression } : {}),
      },
    ],
  };
}
