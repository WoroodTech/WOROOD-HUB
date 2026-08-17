import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../../common/auth';
import { RoomsService } from './services/rooms.service';
import { AvailabilityService } from './services/availability.service';
import { ReservationsService } from './services/reservations.service';
import { MR_PERMISSIONS } from './meeting-rooms.descriptor';
import {
  AvailabilityQueryDto,
  CancelReservationDto,
  CreateReservationDto,
  ListReservationsQueryDto,
  ListRoomsQueryDto,
  UpdateReservationDto,
  UpsertRoomDto,
} from './dto';

const clientIp = (req: Request) =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip;

/* ========================================================================= */
/* Rooms & availability                                                      */
/* ========================================================================= */

@ApiTags('Meeting Rooms')
@Controller({ path: 'meeting-rooms', version: '1' })
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('locations')
  @ApiOperation({ summary: 'List office sites' })
  async locations() {
    return { data: await this.rooms.listLocations() };
  }

  @Get('equipment')
  @ApiOperation({ summary: 'List the equipment catalogue used by the room filters' })
  async equipment() {
    return { data: await this.rooms.listEquipment() };
  }

  @Get('rooms')
  @RequirePermissions(MR_PERMISSIONS.ROOM_READ)
  @ApiOperation({ summary: 'List rooms with capacity, location and equipment' })
  async listRooms(@Query() query: ListRoomsQueryDto) {
    return { data: await this.rooms.list(query) };
  }

  @Get('rooms/:id')
  @RequirePermissions(MR_PERMISSIONS.ROOM_READ)
  @ApiOperation({ summary: 'Room detail' })
  async getRoom(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.rooms.findById(id) };
  }

  @Get('rooms/:id/schedule')
  @RequirePermissions(MR_PERMISSIONS.ROOM_READ)
  @ApiOperation({ summary: 'Day timeline for one room: busy blocks and free slots' })
  async schedule(@Param('id', ParseUUIDPipe) id: string, @Query('date') date: string) {
    return { data: await this.availability.daySchedule(id, date) };
  }

  @Get('availability')
  @RequirePermissions(MR_PERMISSIONS.ROOM_READ)
  @ApiOperation({ summary: 'Find rooms free on a date, filtered by capacity and equipment' })
  async searchAvailability(@Query() query: AvailabilityQueryDto) {
    return { data: await this.availability.search(query) };
  }

  @Get('free-now')
  @RequirePermissions(MR_PERMISSIONS.ROOM_READ)
  @ApiOperation({ summary: 'Rooms with nothing booked for the next N minutes' })
  async freeNow(@Query('minutes') minutes = '30') {
    return { data: await this.availability.freeRightNow(Number(minutes) || 30) };
  }

  /* ------------------------- administration ---------------------------- */

  @Post('rooms')
  @RequirePermissions(MR_PERMISSIONS.ROOM_MANAGE)
  @ApiOperation({ summary: 'Create a room (Facilities)' })
  async createRoom(@Body() dto: UpsertRoomDto) {
    return { data: await this.rooms.create(dto) };
  }

  @Patch('rooms/:id')
  @RequirePermissions(MR_PERMISSIONS.ROOM_MANAGE)
  @ApiOperation({ summary: 'Update a room or its booking policy (Facilities)' })
  async updateRoom(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertRoomDto) {
    return { data: await this.rooms.update(id, dto) };
  }

  @Delete('rooms/:id')
  @RequirePermissions(MR_PERMISSIONS.ROOM_MANAGE)
  @HttpCode(204)
  @ApiOperation({ summary: 'Retire a room — soft delete, history is preserved' })
  async retireRoom(@Param('id', ParseUUIDPipe) id: string) {
    await this.rooms.retire(id);
  }
}

/* ========================================================================= */
/* Reservations                                                              */
/* ========================================================================= */

@ApiTags('Meeting Rooms')
@Controller({ path: 'meeting-rooms/reservations', version: '1' })
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @RequirePermissions(MR_PERMISSIONS.RESERVATION_CREATE)
  @ApiOperation({ summary: 'Reserve a room. Returns 409 if the slot is taken.' })
  async create(
    @Body() dto: CreateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return { data: await this.reservations.create(dto, user, clientIp(req)) };
  }

  @Get()
  @ApiOperation({ summary: 'List reservations — own by default, all with permission' })
  async list(@Query() query: ListReservationsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.list(query, user);
  }

  @Get('next')
  @ApiOperation({ summary: "The signed-in employee's next upcoming meeting" })
  async next(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.reservations.nextMeeting(user) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Reservation detail with attendees' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return { data: await this.reservations.findById(id, user) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modify time, room, title or attendees' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return { data: await this.reservations.update(id, dto, user, clientIp(req)) };
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a reservation and free the slot immediately' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return { data: await this.reservations.cancel(id, dto.reason, user, clientIp(req)) };
  }
}

@Module({
  controllers: [RoomsController, ReservationsController],
  providers: [RoomsService, AvailabilityService, ReservationsService],
  exports: [RoomsService, AvailabilityService, ReservationsService],
})
export class MeetingRoomsModule {}
