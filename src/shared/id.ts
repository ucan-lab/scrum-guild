// 操作の入力に入る ID（UUIDv7 は36字）。DB に問い合わせる前に、桁違いに長い値を 400 で止める
import { z } from 'zod';
import './zod-config.ts';

export const ID_MAX_LENGTH = 64;

export const idSchema = z.string().max(ID_MAX_LENGTH);
