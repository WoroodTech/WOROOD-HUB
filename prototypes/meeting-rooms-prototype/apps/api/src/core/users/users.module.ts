import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../common/database.module';
import type { Database } from '../../db/client';
import { departments, users } from '../../db/schema';

@ApiTags('Directory')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  @ApiOperation({ summary: 'Search the employee directory (used by the attendee picker)' })
  async search(@Query('q') q?: string, @Query('limit') limit = '20') {
    const take = Math.min(Number(limit) || 20, 100);
    const term = q?.trim();

    const rows = await this.db
      .select({
        id: users.id,
        employeeNo: users.employeeNo,
        fullName: users.fullName,
        email: users.email,
        jobTitle: users.jobTitle,
        avatarUrl: users.avatarUrl,
        department: departments.name,
      })
      .from(users)
      .leftJoin(departments, eq(departments.id, users.departmentId))
      .where(
        and(
          isNull(users.deletedAt),
          eq(users.status, 'ACTIVE'),
          term
            ? or(
                ilike(users.fullName, `%${term}%`),
                ilike(sql`${users.email}::text`, `%${term}%`),
                ilike(users.employeeNo, `%${term}%`),
              )
            : undefined,
        ),
      )
      .orderBy(users.fullName)
      .limit(take);

    return { data: rows };
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
