// 本番の操作の一覧の塊 2/6 を回して、組織の分離と権限を確かめる（割り方は test/operations/chunks.ts）
import { defineProductionChunk } from './operations/chunks.ts';

defineProductionChunk(2);
