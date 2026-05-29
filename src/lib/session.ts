export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  provider: 'google' | 'local';
};
