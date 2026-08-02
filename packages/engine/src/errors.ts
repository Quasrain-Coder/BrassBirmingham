/** 行动非法时由引擎抛出的错误。code 为机器可读的错误码，供 server/web 分类处理。 */
export class IllegalActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IllegalActionError';
    this.code = code;
  }
}
