import { describe, expect, it } from 'vitest';
import { roleId, roleName } from '../src/screens/voice/roles';

describe('voice roles', () => {
  it('names a role for the screen', () => {
    expect(roleName('narrator')).toBe('Narrator');
    expect(roleName('dale')).toBe('Dale');
    expect(roleName('')).toBe('');
  });

  it('makes a role id from a name', () => {
    expect(roleId('Dale K.')).toBe('dale-k');
    expect(roleId('  Mrs. O’Hara  ')).toBe('mrs-o-hara');
    expect(roleId('!!!')).toBe('');
  });
});
