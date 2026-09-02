import { Module } from '@nestjs/common';

import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

// The repository and the authorization facade are both global providers: the
// application wires each once, with the connection and the role definitions
// it owns.
@Module({
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
