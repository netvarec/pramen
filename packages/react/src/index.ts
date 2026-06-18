// @mrak/react — React hooks over @mrak/client.
//
//   const client = createClient<typeof app.handlers>({ url, token, tenant });
//   function Notes() {
//     const { data, loading } = useLiveQuery(client, "listNotes");
//     const createNote = useMutation(client, "createNote");
//     ...
//   }
//
// useLiveQuery opens a live subscription and re-renders on every server push
// (row-level — only when this query's result actually changed).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Input, MrakClient, Output } from "@mrak/client";

export interface LiveQueryState<T> {
  data: T | undefined;
  error: { error: string; code: string } | null;
  loading: boolean;
}

export function useLiveQuery<Api, K extends keyof Api & string>(
  client: MrakClient<Api>,
  name: K,
  input?: Input<Api, K>,
): LiveQueryState<Output<Api, K>> {
  const [state, setState] = useState<LiveQueryState<Output<Api, K>>>({
    data: undefined,
    error: null,
    loading: true,
  });

  // Re-subscribe only when the query identity changes.
  const key = JSON.stringify([name, input ?? null]);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    const stop = client.subscribe(name, inputRef.current, {
      onData: (result) => setState({ data: result, error: null, loading: false }),
      onError: (err) => setState((s) => ({ ...s, error: err, loading: false })),
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, name, key]);

  return state;
}

export function useMutation<Api, K extends keyof Api & string>(
  client: MrakClient<Api>,
  name: K,
): (input?: Input<Api, K>) => Promise<Output<Api, K>> {
  return useCallback((input?: Input<Api, K>) => client.call(name, input), [client, name]);
}
