import { describe, expect, it } from 'vitest';
import { parseAgentEnv } from './sshAgentEnv.js';

describe('parseAgentEnv', () => {
  it('extracts sock and pid from ssh-agent -s output', () => {
    const out =
      'SSH_AUTH_SOCK=/tmp/ssh-XX/agent.42; export SSH_AUTH_SOCK;\n' +
      'SSH_AGENT_PID=43; export SSH_AGENT_PID;\n' +
      'echo Agent pid 43;';
    expect(parseAgentEnv(out)).toEqual({ sock: '/tmp/ssh-XX/agent.42', pid: '43' });
  });

  it('returns an empty object when the values are absent', () => {
    expect(parseAgentEnv('nothing here')).toEqual({});
  });

  it('extracts only the socket when the pid line is missing', () => {
    expect(parseAgentEnv('SSH_AUTH_SOCK=/x/y; export SSH_AUTH_SOCK;')).toEqual({ sock: '/x/y' });
  });
});
