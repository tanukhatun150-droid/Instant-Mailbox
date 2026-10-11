import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mailRouter from "./mail";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mailRouter);

export default router;
