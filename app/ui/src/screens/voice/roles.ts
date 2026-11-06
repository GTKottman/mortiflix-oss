export const roleName = (role: string): string =>
  role === 'narrator' ? 'Narrator' : role.replace(/^./, (c) => c.toUpperCase());

/** A role id from a name: "Dale K." -> "dale-k" */
export const roleId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
