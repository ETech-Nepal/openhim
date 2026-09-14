import axios from 'axios';

export function upstreamError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    response: axios.isAxiosError<unknown>(error) ? error.response : undefined,
  };
}
